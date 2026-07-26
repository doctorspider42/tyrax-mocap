import ARKit
import ExpoModulesCore
import SceneKit

// The live viewfinder: the camera with the tracked skeleton drawn over it, so
// you can frame a shot and see whether ARKit has actually found the body before
// pressing record.
//
// It draws the joints the EDITOR will use, not all 91 ARKit reports. That is
// deliberate: the fingers and face joints are noise at this distance, and more
// importantly what you see on screen is then exactly what ends up retargeted -
// the same rule the editor follows between its previews and its bakes. Change
// the list here and the editor's mapping (src/mocap.cpp there) must move with
// it, or the preview starts promising joints nobody uses.
public class TyraxBodyPreview: ExpoView, ARSCNViewDelegate {
  private let sceneView = ARSCNView()
  private let bodyNode = SCNNode()      // sits at the body anchor
  private var jointNodes: [SCNNode] = []
  private var boneNode = SCNNode()
  private var jointIndices: [Int] = []  // into ARKit's joint array
  private var boneIndices: [Int32] = [] // pairs into jointIndices

  // Joint, and the joint it draws a bone back to. ARKit's own names.
  private static let kSkeleton: [(String, String?)] = [
    ("hips_joint", nil),
    ("spine_4_joint", "hips_joint"),
    ("spine_7_joint", "spine_4_joint"),
    ("neck_1_joint", "spine_7_joint"),
    ("head_joint", "neck_1_joint"),
    ("left_shoulder_1_joint", "spine_7_joint"),
    ("left_arm_joint", "left_shoulder_1_joint"),
    ("left_forearm_joint", "left_arm_joint"),
    ("left_hand_joint", "left_forearm_joint"),
    ("right_shoulder_1_joint", "spine_7_joint"),
    ("right_arm_joint", "right_shoulder_1_joint"),
    ("right_forearm_joint", "right_arm_joint"),
    ("right_hand_joint", "right_forearm_joint"),
    ("left_upLeg_joint", "hips_joint"),
    ("left_leg_joint", "left_upLeg_joint"),
    ("left_foot_joint", "left_leg_joint"),
    ("left_toes_joint", "left_foot_joint"),
    ("right_upLeg_joint", "hips_joint"),
    ("right_leg_joint", "right_upLeg_joint"),
    ("right_foot_joint", "right_leg_joint"),
    ("right_toes_joint", "right_foot_joint"),
  ]

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    sceneView.scene = SCNScene()
    sceneView.automaticallyUpdatesLighting = true
    sceneView.rendersContinuously = true
    // Sharing the app's one session rather than making a second: ARKit allows
    // one at a time, and the recorder is already tapping this one.
    sceneView.session = BodySession.shared.session
    sceneView.delegate = self
    sceneView.scene.rootNode.addChildNode(bodyNode)
    bodyNode.addChildNode(boneNode)
    addSubview(sceneView)
    BodySession.shared.viewDidAttach()
  }

  deinit {
    BodySession.shared.viewDidDetach()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    sceneView.frame = bounds
  }

  // --- ARSCNViewDelegate ----------------------------------------------------
  // ARSCNView owns `session.delegate`, so the body data comes through here
  // instead - which is the same data, one callback later.

  public func renderer(_ renderer: SCNSceneRenderer, didUpdate node: SCNNode, for anchor: ARAnchor) {
    guard let body = anchor as? ARBodyAnchor else { return }
    update(body)
  }

  public func renderer(_ renderer: SCNSceneRenderer, didAdd node: SCNNode, for anchor: ARAnchor) {
    guard let body = anchor as? ARBodyAnchor else { return }
    update(body)
  }

  public func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
    BodySession.shared.note(tracking: BodySession.describe(camera.trackingState),
                            at: session.currentFrame?.timestamp ?? 0)
  }

  // --- drawing --------------------------------------------------------------

  private func update(_ body: ARBodyAnchor) {
    let timestamp = sceneView.session.currentFrame?.timestamp ?? 0
    BodySession.shared.feed(anchor: body, timestamp: timestamp)
    BodySession.shared.note(tracking: "normal", at: timestamp)

    let skeleton = body.skeleton
    if jointNodes.isEmpty { build(with: skeleton.definition) }
    guard !jointIndices.isEmpty else { return }

    bodyNode.simdTransform = body.transform

    // Joint transforms are relative to the anchor, and bodyNode IS the anchor,
    // so the local positions drop straight in.
    let locals = skeleton.jointModelTransforms
    var points: [SCNVector3] = []
    points.reserveCapacity(jointIndices.count)
    for (i, ji) in jointIndices.enumerated() {
      let p = locals[ji].columns.3
      jointNodes[i].simdPosition = SIMD3<Float>(p.x, p.y, p.z)
      points.append(SCNVector3(p.x, p.y, p.z))
    }

    // The bones are one line geometry rebuilt per frame. At twenty segments
    // that is cheaper than keeping twenty cylinders oriented.
    let source = SCNGeometrySource(vertices: points)
    let element = SCNGeometryElement(indices: boneIndices, primitiveType: .line)
    let geometry = SCNGeometry(sources: [source], elements: [element])
    let material = SCNMaterial()
    material.lightingModel = .constant
    material.diffuse.contents = UIColor(red: 0.50, green: 0.70, blue: 0.88, alpha: 1)
    material.emission.contents = material.diffuse.contents
    material.isDoubleSided = true
    material.readsFromDepthBuffer = false   // draw over the person, not into them
    material.writesToDepthBuffer = false
    geometry.materials = [material]
    boneNode.geometry = geometry
    boneNode.renderingOrder = 10
  }

  private func build(with definition: ARSkeletonDefinition) {
    let names = definition.jointNames
    var indexOfName: [String: Int] = [:]
    var slotOfName: [String: Int32] = [:]

    for (name, _) in Self.kSkeleton {
      guard let ji = names.firstIndex(of: name) else { continue }
      slotOfName[name] = Int32(jointIndices.count)
      indexOfName[name] = ji
      jointIndices.append(ji)

      let sphere = SCNSphere(radius: name == "head_joint" ? 0.055 : 0.028)
      let material = SCNMaterial()
      material.lightingModel = .constant
      material.diffuse.contents = UIColor.white
      material.emission.contents = UIColor.white
      material.readsFromDepthBuffer = false
      material.writesToDepthBuffer = false
      sphere.materials = [material]
      let node = SCNNode(geometry: sphere)
      node.renderingOrder = 11
      jointNodes.append(node)
      bodyNode.addChildNode(node)
    }

    for (name, parent) in Self.kSkeleton {
      guard let p = parent, let a = slotOfName[name], let b = slotOfName[p] else { continue }
      boneIndices.append(a)
      boneIndices.append(b)
    }
  }
}
