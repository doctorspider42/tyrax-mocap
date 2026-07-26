import ARKit
import ExpoModulesCore

// ARKit body tracking -> a `.tmocap` take the TyraX editor retargets onto a
// generated character.
//
// The recording is buffered and written HERE, in native code, on purpose. A
// take is 91 joints x a 4x4 matrix per frame - about 5.8 KB - and pushing that
// across the JS bridge 30 times a second would cost more than the tracking
// does. JavaScript gets a throttled status (tracking state, frame count, a
// handful of joint positions for the stick figure) and nothing else; the bulk
// never leaves Swift.
//
// ARKit's body space is right-handed, Y up, metres, hips at the origin - the
// same conventions the editor's own rigs use, so the file stores what ARKit
// reports and converts nothing. What the editor does need, and what a stream of
// poses alone would not give it, is the skeleton's REST pose: retargeting is
// "the rotation of this joint relative to its own bind", so `neutralBodySkeleton3D`
// is written into every take.
public class TyraxBodyModule: Module {
  private var session: ARSession?
  private var delegate: BodyDelegate?
  private var recorder: TakeRecorder?

  public func definition() -> ModuleDefinition {
    Name("TyraxBody")

    Events("onStatus")

    // A12 and later (iPhone XS onwards). Anything older can install the app and
    // will be told, rather than crashing on the first session.
    Function("isSupported") { () -> Bool in
      ARBodyTrackingConfiguration.isSupported
    }

    Function("start") {
      self.startSession()
    }

    Function("stop") {
      self.stopSession()
    }

    // Begins buffering frames. `hz` caps the capture rate: ARKit solves at 60,
    // the editor resamples to a keyframe density anyway, and every frame kept
    // is 5.8 KB of take.
    Function("startRecording") { (name: String, hz: Double) -> Bool in
      guard self.session != nil else { return false }
      self.recorder = TakeRecorder(name: name, minInterval: hz > 0 ? 1.0 / hz : 0)
      return true
    }

    // Writes the take and returns what was captured. Returns nil when nothing
    // was recording, or when not one frame saw a body - an empty file would
    // look like a working take that the editor then rejects.
    AsyncFunction("stopRecording") { () -> [String: Any]? in
      guard let recorder = self.recorder else { return nil }
      self.recorder = nil
      return try recorder.finish()
    }

    Function("isRecording") { () -> Bool in
      self.recorder != nil
    }

    OnDestroy {
      self.stopSession()
    }
  }

  private static func configuration() -> ARBodyTrackingConfiguration {
    let cfg = ARBodyTrackingConfiguration()
    cfg.automaticSkeletonScaleEstimationEnabled = true  // real limb lengths
    cfg.planeDetection = []
    cfg.isLightEstimationEnabled = false
    return cfg
  }

  private func startSession() {
    stopSession()
    guard ARBodyTrackingConfiguration.isSupported else {
      sendEvent("onStatus", ["tracking": "unsupported", "body": false, "frames": 0, "elapsed": 0.0])
      return
    }
    let session = ARSession()
    let delegate = BodyDelegate(
      onBody: { [weak self] anchor, timestamp in
        self?.recorder?.append(anchor: anchor, timestamp: timestamp)
      },
      onStatus: { [weak self] payload in
        var out = payload
        out["frames"] = self?.recorder?.frameCount ?? 0
        out["elapsed"] = self?.recorder?.elapsed ?? 0.0
        out["recording"] = self?.recorder != nil
        self?.sendEvent("onStatus", out)
      })
    session.delegate = delegate
    self.session = session
    self.delegate = delegate
    session.run(Self.configuration(), options: [.resetTracking, .removeExistingAnchors])
  }

  private func stopSession() {
    recorder = nil
    session?.pause()
    session?.delegate = nil
    session = nil
    delegate = nil
  }
}

// ---------------------------------------------------------------------------

private class BodyDelegate: NSObject, ARSessionDelegate {
  private let onBody: (ARBodyAnchor, TimeInterval) -> Void
  private let onStatus: ([String: Any]) -> Void
  private var lastStatus: TimeInterval = 0
  private var lastState = ""
  private var sawBody = false

  init(onBody: @escaping (ARBodyAnchor, TimeInterval) -> Void,
       onStatus: @escaping ([String: Any]) -> Void) {
    self.onBody = onBody
    self.onStatus = onStatus
  }

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    let state = Self.describe(frame.camera.trackingState)
    // Status is for a human reading a screen from three metres away: five
    // updates a second is plenty, and a state change always gets through.
    if state != lastState || frame.timestamp - lastStatus > 0.2 {
      lastState = state
      lastStatus = frame.timestamp
      onStatus(["tracking": state, "body": sawBody])
    }
    sawBody = false
  }

  func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
    for case let body as ARBodyAnchor in anchors {
      sawBody = true
      onBody(body, session.currentFrame?.timestamp ?? Date().timeIntervalSince1970)
    }
  }

  func session(_ session: ARSession, didFailWithError error: Error) {
    onStatus(["tracking": "failed: \(error.localizedDescription)", "body": false])
  }

  func sessionWasInterrupted(_ session: ARSession) {
    onStatus(["tracking": "interrupted", "body": false])
  }

  func sessionInterruptionEnded(_ session: ARSession) { lastState = "" }

  private static func describe(_ s: ARCamera.TrackingState) -> String {
    switch s {
    case .normal: return "normal"
    case .notAvailable: return "initialising"
    case .limited(let reason):
      switch reason {
      case .initializing: return "initialising"
      case .excessiveMotion: return "limited: moving too fast"
      case .insufficientFeatures: return "limited: not enough detail to track"
      case .relocalizing: return "relocalising"
      @unknown default: return "limited"
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The `.tmocap` writer. Format lives in PROTOCOL.md; keep the two in step.

private class TakeRecorder {
  private let name: String
  private let minInterval: Double
  private var frames = Data()
  private var startedAt: TimeInterval = -1
  private var lastKept: TimeInterval = -1
  private var kept = 0
  private var duration: Double = 0
  private var jointNames: [String] = []
  private var parents: [Int] = []
  private var neutral: [simd_float4x4] = []

  var frameCount: Int { kept }
  var elapsed: Double { duration }

  init(name: String, minInterval: Double) {
    self.name = name
    self.minInterval = minInterval
  }

  func append(anchor: ARBodyAnchor, timestamp: TimeInterval) {
    let skeleton = anchor.skeleton
    if jointNames.isEmpty {
      let def = skeleton.definition
      jointNames = def.jointNames
      parents = def.parentIndices
      // The rest pose the whole retarget is expressed relative to. Fall back to
      // this take's first frame if ARKit will not hand over the neutral one -
      // wrong, but recoverable; an absent rest pose is not.
      neutral = ARSkeletonDefinition.defaultBody3D.neutralBodySkeleton3D?.jointLocalTransforms
        ?? skeleton.jointLocalTransforms
    }
    if startedAt < 0 { startedAt = timestamp }
    if minInterval > 0 && lastKept >= 0 && timestamp - lastKept < minInterval { return }
    lastKept = timestamp

    let t = Float(timestamp - startedAt)
    duration = Double(t)
    withUnsafeBytes(of: t) { frames.append(contentsOf: $0) }
    appendMatrix(anchor.transform, to: &frames)
    for m in skeleton.jointLocalTransforms { appendMatrix(m, to: &frames) }
    kept += 1
  }

  func finish() throws -> [String: Any]? {
    guard kept > 0, !jointNames.isEmpty else { return nil }

    var out = Data()
    out.append(contentsOf: Array("TMCP".utf8))
    appendU32(1, to: &out)                       // version
    appendU32(0, to: &out)                       // flags
    appendF32(Float(kept) / Float(max(duration, 0.001)), to: &out)  // effective fps
    appendU32(UInt32(jointNames.count), to: &out)
    appendU32(UInt32(kept), to: &out)
    appendF32(Float(duration), to: &out)

    for (i, jointName) in jointNames.enumerated() {
      let bytes = Array(jointName.utf8)
      appendU16(UInt16(bytes.count), to: &out)
      out.append(contentsOf: bytes)
      appendI16(Int16(i < parents.count ? parents[i] : -1), to: &out)
    }
    for m in neutral { appendMatrix(m, to: &out) }
    out.append(frames)

    let dir = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask,
                                          appropriateFor: nil, create: true)
      .appendingPathComponent("takes", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appendingPathComponent("\(name).tmocap")
    try out.write(to: url, options: .atomic)

    return [
      "path": url.path,
      "uri": url.absoluteString,
      "name": "\(name).tmocap",
      "frames": kept,
      "duration": duration,
      "joints": jointNames.count,
      "bytes": out.count,
    ]
  }
}

// Little-endian primitives. Every iOS device is little-endian, but the reader
// on the other side is explicit about it, so this is too.
private func appendU16(_ v: UInt16, to data: inout Data) {
  withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) }
}
private func appendI16(_ v: Int16, to data: inout Data) {
  withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) }
}
private func appendU32(_ v: UInt32, to data: inout Data) {
  withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) }
}
private func appendF32(_ v: Float, to data: inout Data) {
  withUnsafeBytes(of: v.bitPattern.littleEndian) { data.append(contentsOf: $0) }
}
// Column-major, the order simd and glTF both use.
private func appendMatrix(_ m: simd_float4x4, to data: inout Data) {
  for c in 0..<4 {
    let col = m[c]
    appendF32(col.x, to: &data)
    appendF32(col.y, to: &data)
    appendF32(col.z, to: &data)
    appendF32(col.w, to: &data)
  }
}
