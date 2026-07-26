import ARKit
import ExpoModulesCore

// ARKit body tracking -> a `.tmocap` take the TyraX editor retargets onto a
// generated character, plus the live viewfinder that shows the tracked skeleton
// drawn over the camera.
//
// The session and the recorder live in BodySession; this file is the JS face of
// them and nothing else. The split exists because there are two ways body
// anchors arrive (with a preview on screen and without one) and exactly one
// recorder they both have to reach - see BodySession.swift.
//
// The recording is buffered and written in NATIVE code on purpose. A take is
// 91 joints x a 4x4 matrix per frame - about 5.8 KB - and pushing that across
// the JS bridge 30 times a second would cost more than the tracking does.
// JavaScript gets a throttled status (tracking state, frame count) and nothing
// else; the bulk never leaves Swift.
public class TyraxBodyModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TyraxBody")

    Events("onStatus", "onFrame")

    OnStartObserving {
      BodySession.shared.onStatus = { [weak self] payload in
        self?.sendEvent("onStatus", payload)
      }
      BodySession.shared.onFrame = { [weak self] ts, rot, hips in
        self?.sendEvent("onFrame", ["ts": ts, "rot": rot, "hips": hips])
      }
    }

    OnStopObserving {
      BodySession.shared.onStatus = nil
      BodySession.shared.onFrame = nil
    }

    // A12 and later (iPhone XS onwards). Anything older can install the app and
    // will be told, rather than crashing on the first session.
    Function("isSupported") { () -> Bool in
      ARBodyTrackingConfiguration.isSupported
    }

    Function("start") {
      BodySession.shared.start()
    }

    // The capture formats ARKit will accept for body tracking, in its own
    // order. There is no front/rear choice to make - body tracking is rear
    // only - but on a phone with more than one rear lens this list is where
    // the wide one shows up, and that decides how far back you have to stand.
    Function("videoFormats") { () -> [[String: Any]] in
      BodySession.formats.enumerated().map { (i, f) in
        var row: [String: Any] = [
          "index": i,
          "width": Int(f.imageResolution.width),
          "height": Int(f.imageResolution.height),
          "fps": f.framesPerSecond,
          "selected": i == BodySession.shared.formatIndex,
        ]
        if #available(iOS 14.5, *) {
          // The raw device type reads like "AVCaptureDeviceTypeBuiltInUltraWideCamera";
          // JavaScript makes it presentable.
          row["lens"] = f.captureDeviceType.rawValue
        }
        return row
      }
    }

    // Restarts tracking on the chosen format; -1 hands the choice back to
    // ARKit. Any recording in progress is dropped rather than gaining a
    // discontinuity halfway through.
    Function("setVideoFormat") { (index: Int) in
      BodySession.shared.selectFormat(index)
    }

    Function("stop") {
      BodySession.shared.stop()
    }

    // Begins buffering frames. `hz` caps the capture rate: ARKit solves at 60,
    // the editor resamples to a keyframe density anyway, and every frame kept
    // is 5.8 KB of take.
    Function("startRecording") { (name: String, hz: Double) -> Bool in
      BodySession.shared.startRecording(name: name, hz: hz)
    }

    // Writes the take and returns what was captured. Returns nil when nothing
    // was recording, or when not one frame saw a body - an empty file would
    // look like a working take that the editor then rejects.
    AsyncFunction("stopRecording") { () -> [String: Any]? in
      try BodySession.shared.finishRecording()
    }

    Function("isRecording") { () -> Bool in
      BodySession.shared.recorder != nil
    }

    // The skeleton the editor needs once per session - names, the tree and the
    // rest pose. nil before ARKit has handed over its definition.
    Function("skeleton") { () -> [String: Any]? in
      BodySession.shared.skeletonPayload()
    }

    // While streaming, every kept frame is packed natively and handed to
    // JavaScript as base64 for the socket. `hz` caps the rate.
    Function("setStreaming") { (on: Bool, hz: Double) in
      BodySession.shared.streamInterval = hz > 0 ? 1.0 / hz : 0
      BodySession.shared.streaming = on
    }

    // The live viewfinder. Mounting one attaches it to the session that is
    // already running; unmounting it hands the session back to the headless
    // path, so recording works either way.
    View(TyraxBodyPreview.self) {}

    OnDestroy {
      BodySession.shared.stop()
    }
  }
}
