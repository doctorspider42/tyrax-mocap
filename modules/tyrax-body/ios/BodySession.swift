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
  private var sawBodyRecently = false

  // Set by the module so status can reach JavaScript.
  var onStatus: (([String: Any]) -> Void)?
  // Set while the app is streaming: one call per frame with the pose already
  // packed. JavaScript owns the socket (as in tyrax-cam) but never sees a
  // joint - it forwards an opaque blob, which is what keeps ~1.5 KB a frame
  // off the bridge as anything but base64.
  var onFrame: ((_ ts: Double, _ rotBase64: String, _ hips: [Float]) -> Void)?
  var streaming = false

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
      let q = simd_quatf(simd_float3x3(SIMD3(m.columns.0.x, m.columns.0.y, m.columns.0.z),
                                       SIMD3(m.columns.1.x, m.columns.1.y, m.columns.1.z),
                                       SIMD3(m.columns.2.x, m.columns.2.y, m.columns.2.z)))
      for v in [q.imag.x, q.imag.y, q.imag.z, q.real] {
        withUnsafeBytes(of: v.bitPattern.littleEndian) { data.append(contentsOf: $0) }
      }
    }
    let t = anchor.transform.columns.3
    onFrame(timestamp - streamStart, data.base64EncodedString(), [t.x, t.y, t.z])
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
      let q = simd_quatf(simd_float3x3(SIMD3(m.columns.0.x, m.columns.0.y, m.columns.0.z),
                                       SIMD3(m.columns.1.x, m.columns.1.y, m.columns.1.z),
                                       SIMD3(m.columns.2.x, m.columns.2.y, m.columns.2.z)))
      for v in [q.imag.x, q.imag.y, q.imag.z, q.real] {
        withUnsafeBytes(of: v.bitPattern.littleEndian) { rot.append(contentsOf: $0) }
      }
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
