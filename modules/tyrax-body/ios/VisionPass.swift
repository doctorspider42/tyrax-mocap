import ARKit
import Vision

// The second opinion: what ARKit's body tracker reports but does not solve.
//
// Measured on a real take, the head (relative to the neck) and both wrists were
// constant to the last float bit across 277 frames - ARKit puts those joints in
// the skeleton and never moves them. Hand and face tracking on iOS live in
// Vision instead, and Vision is happy to run over the very same camera frames
// this session is already producing.
//
// This class does the LOOKING and nothing else. The landmarks and the face's
// angles go out to the editor exactly as Vision reported them, because the
// geometry that turns them into joint rotations belongs where it can be tested
// against synthetic data and fixed without a release - and that is not here.
final class VisionPass {
    // Vision is not free and ARKit is already using the Neural Engine. Twelve a
    // second against the body tracker's sixty is deliberate: the editor blends
    // between what it is given, and a head that updates at 12 Hz looks like a
    // head, whereas a body tracker starved of its budget looks like a fault.
    var interval: Double = 1.0 / 12.0

    private(set) var latest = Result()
    private let queue = DispatchQueue(label: "tyrax.vision", qos: .userInitiated)
    private var busy = false
    private var lastRun: TimeInterval = -1

    struct Hand {
        var found = false
        var confidence: Float = 0
        // Normalized, Vision's own frame: origin BOTTOM-left, both axes over
        // [0, 1] and therefore anisotropic on a non-square image. Neither is
        // corrected here - the frame carries the image's aspect and the editor
        // applies it, so a convention that turns out to be wrong is one line
        // away from being right instead of one release.
        var wrist = CGPoint.zero
        var indexMcp = CGPoint.zero
        var middleMcp = CGPoint.zero
        var littleMcp = CGPoint.zero
        var thumb = CGPoint.zero
        var haveThumb = false
    }

    struct Result {
        var faceFound = false
        var yaw: Float = 0
        var pitch: Float = 0
        var roll: Float = 0
        // Which way is the face looking, in the image - used to pick the face
        // nearest the tracked body when more than one person is in frame.
        var faceCenter = CGPoint.zero
        var left = Hand()
        var right = Hand()
        var aspect: Float = 1.0   // image width / height
    }

    // Called from the ARKit delegate. Returns immediately: the work runs on its
    // own queue and the next frame to go out picks up whatever finished.
    func consider(frame: ARFrame) {
        guard !busy else { return }
        if lastRun >= 0 && frame.timestamp - lastRun < interval { return }
        lastRun = frame.timestamp
        busy = true

        let buffer = frame.capturedImage
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        // The wrist landmarks are the important ones and they are large; the
        // body is not moving between here and the handler, so a retained buffer
        // is enough and nothing needs copying.
        queue.async { [weak self] in
            guard let self = self else { return }
            defer { self.busy = false }
            var out = Result()
            out.aspect = height > 0 ? Float(width) / Float(height) : 1.0

            let handler = VNImageRequestHandler(cvPixelBuffer: buffer, orientation: .up,
                                                options: [:])
            let face = VNDetectFaceRectanglesRequest()
            // Revision 3 is what reports pitch as well as yaw and roll; without
            // it a nod is invisible.
            if #available(iOS 15.0, *) {
                face.revision = VNDetectFaceRectanglesRequestRevision3
            }
            let hands = VNDetectHumanHandPoseRequest()
            hands.maximumHandCount = 2

            do {
                try handler.perform([face, hands])
            } catch {
                self.latest = out
                return
            }

            // The biggest face is the performer. A bystander further away is
            // smaller, and choosing by size beats choosing by confidence, which
            // says how sure Vision is that it IS a face, not whose.
            if let best = (face.results ?? []).max(by: {
                $0.boundingBox.width * $0.boundingBox.height <
                    $1.boundingBox.width * $1.boundingBox.height
            }) {
                out.faceFound = true
                out.yaw = Float(truncating: best.yaw ?? 0)
                out.roll = Float(truncating: best.roll ?? 0)
                if #available(iOS 15.0, *) {
                    out.pitch = Float(truncating: best.pitch ?? 0)
                }
                out.faceCenter = CGPoint(x: best.boundingBox.midX, y: best.boundingBox.midY)
            }

            for observation in (hands.results ?? []) {
                var hand = Hand()
                hand.confidence = observation.confidence
                func point(_ name: VNHumanHandPoseObservation.JointName) -> (CGPoint, Bool) {
                    guard let p = try? observation.recognizedPoint(name), p.confidence > 0.3 else {
                        return (.zero, false)
                    }
                    return (p.location, true)
                }
                let (wrist, okWrist) = point(.wrist)
                let (index, okIndex) = point(.indexMCP)
                let (middle, okMiddle) = point(.middleMCP)
                let (little, okLittle) = point(.littleMCP)
                // Four coplanar points cannot tell a palm from the back of a
                // hand - a plane and its mirror project identically. The thumb
                // sits off that plane, which is the whole reason it is here.
                let (thumb, okThumb) = point(.thumbMP)
                guard okWrist && okIndex && okMiddle && okLittle else { continue }
                hand.found = true
                hand.wrist = wrist
                hand.indexMcp = index
                hand.middleMcp = middle
                hand.littleMcp = little
                hand.thumb = thumb
                hand.haveThumb = okThumb

                // Vision's chirality is about the hand's own shape and it is
                // wrong often enough at this distance to matter. Which arm a
                // hand belongs to is decided in the editor, which knows where
                // both wrists actually are in three dimensions; here they are
                // simply sorted left-to-right in the image so the editor gets a
                // stable pair to reason about.
                if !out.left.found {
                    out.left = hand
                } else if !out.right.found {
                    if hand.wrist.x < out.left.wrist.x {
                        out.right = out.left
                        out.left = hand
                    } else {
                        out.right = hand
                    }
                }
            }
            self.latest = out
        }
    }

    func reset() {
        latest = Result()
        lastRun = -1
    }
}
