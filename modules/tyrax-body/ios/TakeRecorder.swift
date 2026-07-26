import ARKit

// The `.tmocap` writer. The format lives in PROTOCOL.md, and the editor reads
// it in src/mocap.cpp - **keep all three in step**, the layout is spread over
// two repositories.
class TakeRecorder {
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
