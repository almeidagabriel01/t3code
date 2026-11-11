import Foundation

/// serve-sim's AVCC stream: `[u32 big-endian length][tag][payload]`, where length counts the tag.
public enum EnvelopeTag: UInt8 {
  /// The `avcC` decoder configuration record.
  case description = 1
  /// Length-prefixed NAL units holding an IDR.
  case keyframe = 2
  case delta = 3
  /// A JPEG still. This helper never sends one.
  case seed = 4
}

public func envelope(_ tag: EnvelopeTag, _ payload: Data) -> Data {
  var out = Data(capacity: payload.count + 5)
  let length = UInt32(payload.count + 1)
  out.append(UInt8(truncatingIfNeeded: length >> 24))
  out.append(UInt8(truncatingIfNeeded: length >> 16))
  out.append(UInt8(truncatingIfNeeded: length >> 8))
  out.append(UInt8(truncatingIfNeeded: length))
  out.append(tag.rawValue)
  out.append(payload)
  return out
}

/// Builds the `avcC` record a WebCodecs decoder takes as its description, with 4-byte NAL lengths.
public func avcDecoderConfiguration(sps: Data, pps: Data) -> Data? {
  guard sps.count >= 4, sps.count <= 0xFFFF, !pps.isEmpty, pps.count <= 0xFFFF else { return nil }
  let bytes = [UInt8](sps)
  var out = Data([1, bytes[1], bytes[2], bytes[3], 0xFF, 0xE1])
  out.append(contentsOf: [UInt8(sps.count >> 8), UInt8(sps.count & 0xFF)])
  out.append(sps)
  out.append(contentsOf: [1, UInt8(pps.count >> 8), UInt8(pps.count & 0xFF)])
  out.append(pps)
  // High profiles carry the chroma format and bit depths: 4:2:0, 8-bit, no SPS extensions.
  if [100, 110, 122, 144].contains(bytes[1]) {
    out.append(contentsOf: [0xFD, 0xF8, 0xF8, 0])
  }
  return out
}

/// Fits a frame inside `maxDimension` on its long edge, keeping aspect and even sides.
public func scaledSize(width: Int, height: Int, maxDimension: Int) -> (width: Int, height: Int) {
  let longEdge = max(width, height)
  let scale = longEdge > maxDimension ? Double(maxDimension) / Double(longEdge) : 1
  let even = { (value: Int) in max(2, Int((Double(value) * scale).rounded()) & ~1) }
  return (even(width), even(height))
}
