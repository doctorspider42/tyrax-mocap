import ARKit

// The one ARKit session the app has, and the take recorder that taps it.
//
// There are two ways body anchors reach here, and only ever one at a time:
//
//  - **headless** - the module runs the session and is its ARSessionDelegate.
//    That is the whole app before a preview is mounted, and it is enough to
//    record: a take needs joint transforms, not pictures.
//  - **through the preview** - an ARSCNView showing the camera. ARSCNView
//    takes `session.delegate` for itself when a session is assigned to it, so
//    fighting it for that slot loses the video feed. The view therefore feeds
//    us from its OWN delegate (ARSCNViewDelegate, which still carries anchor
//    updates and tracking state) and the headless delegate stands down while a
//    view is attached.
//
// Both paths end in `feed(anchor:timestamp:)`, so a recording made with the
// preview open is the same file as one made without it.
final class BodySession {
  static let shared = BodySession()

  let session = ARSession()
  private(set) var recorder: TakeRecorder?
  private(set) var running = false
  private(set) var viewAttached = false

  private var headlessDelegate: HeadlessDelegate?
  private var lastState = ""
  private var lastStatusAt: TimeInterval = 0
  // Streaming is capped the same way recording is: ARKit solves at 60 and the
  // editor resamples anyway, so half of that is plenty and halves the traffic.
  var streamInterval: Double = 1.0 / 30.0
  private var lastStreamed: TimeInterval = -1
  private var streamStart: TimeInterval = -1
  // Vision reports the face's angles RELATIVE TO THE CAMERA, so the camera's
  // own orientation has to travel with them or the head is oriented in a frame
  // that moves whenever the operator does.
  private var lastCameraRotation: simd_quatf?
  private var sawBodyRecently = false

  // Set by the module so status can reach JavaScript.
  var onStatus: (([String: Any]) -> Void)?
  // Set while the app is streaming: one call per frame with the pose already
  // packed. JavaScript owns the socket (as in tyrax-cam) but never sees a
  // joint - it forwards an opaque blob, which is what keeps ~1.5 KB a frame
  // off the bridge as anything but base64.
  var onFrame: ((_ ts: Double, _ rotBase64: String, _ hips: [Float], _ root: [Float],
                 _ extra: [String: Any]) -> Void)?
  var streaming = false
  // The second opinion on the joints ARKit will not solve. Fed from the same
  // delegate that feeds the recorder, throttled to a fraction of ARKit's rate.
  let vision = VisionPass()
  var visionEnabled = true

  // Which of ARKit's supported capture formats to run. -1 = whatever ARKit
  // picks for itself.
  //
  // This is the only "choose a camera" there is: body tracking is REAR camera
  // only (the front one does faces, not bodies), and ARKit will not take an
  // arbitrary AVCaptureDevice. What the format list does carry - and what makes
  // it worth exposing - is the LENS: on a phone with an ultra-wide, one of
  // these formats uses it, and that is the difference between needing three
  // metres to fit a whole person in frame and needing one and a half.
  private(set) var formatIndex = -1

  static var formats: [ARConfiguration.VideoFormat] {
    ARBodyTrackingConfiguration.supportedVideoFormats
  }

  func configuration() -> ARBodyTrackingConfiguration {
    let cfg = ARBodyTrackingConfiguration()
    cfg.automaticSkeletonScaleEstimationEnabled = true  // real limb lengths
    cfg.planeDetection = []
    cfg.isLightEstimationEnabled = false
    let all = Self.formats
    if formatIndex >= 0 && formatIndex < all.count { cfg.videoFormat = all[formatIndex] }
    return cfg
  }

  // Re-runs the session on a different format. Tracking restarts (there is no
  // way to swap a format live), so a recording in progress is ended first
  // rather than silently gaining a discontinuity in the middle.
  func selectFormat(_ index: Int) {
    formatIndex = index
    guard running else { return }
    recorder = nil
    session.run(configuration(), options: [.resetTracking, .removeExistingAnchors])
  }

  func start() {
    guard ARBodyTrackingConfiguration.isSupported else {
      emit(tracking: "unsupported", body: false)
      return
    }
    if headlessDelegate == nil {
      let d = HeadlessDelegate(owner: self)
      headlessDelegate = d
      // Only meaningful while no view is attached - ARSCNView replaces it.
      if !viewAttached { session.delegate = d }
    }
    session.run(configuration(), options: [.resetTracking, .removeExistingAnchors])
    running = true
  }

  func stop() {
    recorder = nil
    streaming = false
    lastStreamed = -1
    streamStart = -1
    lastCameraRotation = nil
    vision.reset()
    session.pause()
    running = false
  }

  // --- preview attachment ---------------------------------------------------

  func viewDidAttach() {
    viewAttached = true
    if !running { start() }
  }

  func viewDidDetach() {
    viewAttached = false
    // Take the delegate slot back so recording keeps working without a preview.
    if let d = headlessDelegate { session.delegate = d }
  }

  // --- recording ------------------------------------------------------------

  func startRecording(name: String, hz: Double) -> Bool {
    guard running else { return false }
    recorder = TakeRecorder(name: name, minInterval: hz > 0 ? 1.0 / hz : 0)
    return true
  }

  func finishRecording() throws -> [String: Any]? {
    guard let r = recorder else { return nil }
    recorder = nil
    return try r.finish()
  }

  // --- the two feeds --------------------------------------------------------

  func feed(anchor: ARBodyAnchor, timestamp: TimeInterval) {
    sawBodyRecently = true
    recorder?.append(anchor: anchor, timestamp: timestamp)
    // One place for both delegates. `currentFrame` is read and immediately
    // reduced to its pixel buffer - holding on to an ARFrame stalls the session,
    // and the buffer is all Vision wants anyway.
    if let frame = session.currentFrame {
      lastCameraRotation = simd_quatf(frame.camera.transform)
      if visionEnabled && streaming { vision.consider(frame: frame) }
    }
    guard streaming, let onFrame = onFrame else { return }
    // Rotations only. Bone lengths do not change during a take, so the rest
    // pose the editor already has covers the translations - sending 4 floats a
    // joint instead of 16 is most of why this fits comfortably in a Wi-Fi
    // frame at 30 Hz.
    if streamStart < 0 { streamStart = timestamp }
    if streamInterval > 0 && lastStreamed >= 0 &&
       timestamp - lastStreamed < streamInterval { return }
    lastStreamed = timestamp
    let skeleton = anchor.skeleton
    var data = Data(capacity: skeleton.jointLocalTransforms.count * 16)
    for m in skeleton.jointLocalTransforms {
      appendQuat(&data, rotationOf(m))
    }
    // The anchor is where the body is AND which way it faces. The heading is
    // NOT in the skeleton: ARKit holds hips_joint's own rotation constant to the
    // last bit while a performer turns a full circle, so a frame that carries
    // only the position retargets someone walking a circle as someone marching
    // on the spot.
    let t = anchor.transform.columns.3
    let q = rotationOf(anchor.transform)
    onFrame(timestamp - streamStart, data.base64EncodedString(), [t.x, t.y, t.z],
            [q.imag.x, q.imag.y, q.imag.z, q.real], visionPayload())
  }

  // What Vision saw, packed for the wire. Nothing is interpreted: the angles
  // and landmarks go out as reported, plus the camera's orientation and the
  // image's aspect, because the editor needs both to make sense of the rest and
  // neither is worth guessing at twice.
  private func visionPayload() -> [String: Any] {
    guard visionEnabled else { return [:] }
    var out: [String: Any] = [:]
    if let cam = lastCameraRotation {
      out["cq"] = [cam.imag.x, cam.imag.y, cam.imag.z, cam.real]
    }
    let r = vision.latest
    out["ia"] = r.aspect
    if r.faceFound { out["fa"] = [r.yaw, r.pitch, r.roll] }
    func pack(_ h: VisionPass.Hand) -> [Float]? {
      guard h.found else { return nil }
      // Confidence, then five landmarks. An unsure thumb goes as (-1, -1),
      // which is off the image and so cannot be read as a position.
      let thumbX: Float = h.haveThumb ? Float(h.thumb.x) : -1
      let thumbY: Float = h.haveThumb ? Float(h.thumb.y) : -1
      return [h.confidence,
              Float(h.wrist.x), Float(h.wrist.y),
              Float(h.indexMcp.x), Float(h.indexMcp.y),
              Float(h.middleMcp.x), Float(h.middleMcp.y),
              Float(h.littleMcp.x), Float(h.littleMcp.y),
              thumbX, thumbY]
    }
    if let l = pack(r.left) { out["hl"] = l }
    if let rr = pack(r.right) { out["hr"] = rr }
    return out
  }

  // The skeleton the editor needs once: names, the tree, and the rest pose
  // (position + rotation per joint) as base64, in the order the frames use.
  func skeletonPayload() -> [String: Any]? {
    guard let neutral = ARSkeletonDefinition.defaultBody3D.neutralBodySkeleton3D else { return nil }
    let def = ARSkeletonDefinition.defaultBody3D
    var pos = Data(), rot = Data()
    for m in neutral.jointLocalTransforms {
      let t = m.columns.3
      for v in [t.x, t.y, t.z] {
        withUnsafeBytes(of: v.bitPattern.littleEndian) { pos.append(contentsOf: $0) }
      }
      appendQuat(&rot, rotationOf(m))
    }
    // The editor expects position then rotation, one run after the other.
    var payload = pos
    payload.append(rot)
    return [
      "joints": def.jointNames,
      "parents": def.parentIndices,
      "rest": payload.base64EncodedString(),
    ]
  }

  // Status is for a human reading a screen from three metres away: five updates
  // a second is plenty, and a state change always gets through.
  func note(tracking: String, at timestamp: TimeInterval) {
    if tracking != lastState || timestamp - lastStatusAt > 0.2 {
      lastState = tracking
      lastStatusAt = timestamp
      emit(tracking: tracking, body: sawBodyRecently)
      sawBodyRecently = false
    }
  }

  func emit(tracking: String, body: Bool) {
    onStatus?([
      "tracking": tracking,
      "body": body,
      "frames": recorder?.frameCount ?? 0,
      "elapsed": recorder?.elapsed ?? 0.0,
      "recording": recorder != nil,
    ])
  }

  static func describe(_ s: ARCamera.TrackingState) -> String {
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

// The delegate used while nothing is on screen.
private class HeadlessDelegate: NSObject, ARSessionDelegate {
  private unowned let owner: BodySession

  init(owner: BodySession) { self.owner = owner }

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    guard !owner.viewAttached else { return }
    owner.note(tracking: BodySession.describe(frame.camera.trackingState), at: frame.timestamp)
  }

  func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
    guard !owner.viewAttached else { return }
    for case let body as ARBodyAnchor in anchors {
      owner.feed(anchor: body, timestamp: session.currentFrame?.timestamp ?? 0)
    }
  }

  func session(_ session: ARSession, didFailWithError error: Error) {
    owner.emit(tracking: "failed: \(error.localizedDescription)", body: false)
  }

  func sessionWasInterrupted(_ session: ARSession) {
    owner.emit(tracking: "interrupted", body: false)
  }
}

// A joint's rotation with ARKit's SCALE dropped. Its skeleton-scale estimation
// puts the performer's real limb lengths in the local transforms, and
// simd_quatf wants an orthonormal basis - feeding it a scaled one yields a
// rotation that is quietly wrong. The editor drops scale the same way when it
// decomposes a recorded take; the two paths have to agree.
private func rotationOf(_ m: simd_float4x4) -> simd_quatf {
  func unit(_ c: SIMD4<Float>) -> SIMD3<Float> {
    let v = SIMD3(c.x, c.y, c.z)
    let len = simd_length(v)
    return len > 1e-6 ? v / len : SIMD3(0, 0, 0)
  }
  return simd_quatf(simd_float3x3(unit(m.columns.0), unit(m.columns.1), unit(m.columns.2)))
}

// x, y, z, w - the order the editor reads, little-endian.
private func appendQuat(_ data: inout Data, _ q: simd_quatf) {
  for v in [q.imag.x, q.imag.y, q.imag.z, q.real] {
    withUnsafeBytes(of: v.bitPattern.littleEndian) { data.append(contentsOf: $0) }
  }
}
