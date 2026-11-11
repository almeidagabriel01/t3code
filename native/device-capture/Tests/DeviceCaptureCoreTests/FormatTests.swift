import XCTest

@testable import DeviceCaptureCore

/// Splits a body the way the viewer's `AvccDemuxer` does (packages/client-runtime/src/device/stream.ts).
func demux(_ bytes: [UInt8]) -> [(tag: UInt8, payload: [UInt8])] {
  var chunks: [(tag: UInt8, payload: [UInt8])] = []
  var offset = 0
  while bytes.count - offset >= 4 {
    let length = bytes[offset..<offset + 4].reduce(0) { $0 << 8 | Int($1) }
    guard bytes.count - offset - 4 >= length else { break }
    if length >= 1 {
      chunks.append((bytes[offset + 4], Array(bytes[offset + 5..<offset + 4 + length])))
    }
    offset += 4 + length
  }
  return chunks
}

final class FormatTests: XCTestCase {
  func testEnvelopeMatchesServeSim() {
    // serve-sim frames a seed JPEG as writeUInt32BE(length + 1), the tag 4, then the bytes.
    XCTAssertEqual([UInt8](envelope(.seed, Data([0xAA, 0xBB]))), [0, 0, 0, 3, 4, 0xAA, 0xBB])
    XCTAssertEqual([UInt8](envelope(.description, Data([1, 0x64, 0, 0x1F]))), [0, 0, 0, 5, 1, 1, 0x64, 0, 0x1F])
    XCTAssertEqual([UInt8](envelope(.keyframe, Data())), [0, 0, 0, 1, 2])
    let large = Data(repeating: 7, count: 0x01_02_03)
    XCTAssertEqual([UInt8](envelope(.delta, large).prefix(5)), [0, 0x01, 0x02, 0x04, 3])

    let stream = envelope(.description, Data([9])) + envelope(.keyframe, Data([1, 2])) + envelope(.delta, Data([3]))
    let chunks = demux([UInt8](stream))
    XCTAssertEqual(chunks.map(\.tag), [1, 2, 3])
    XCTAssertEqual(chunks.map(\.payload), [[9], [1, 2], [3]])
  }

  func testDecoderConfiguration() {
    let pps = Data([0x68, 0xEE, 0x3C, 0x80])
    let main = Data([0x67, 0x4D, 0x40, 0x1F, 0xAB])
    XCTAssertEqual(
      [UInt8](avcDecoderConfiguration(sps: main, pps: pps)!),
      [1, 0x4D, 0x40, 0x1F, 0xFF, 0xE1, 0, 5, 0x67, 0x4D, 0x40, 0x1F, 0xAB, 1, 0, 4, 0x68, 0xEE, 0x3C, 0x80])
    let high = Data([0x67, 0x64, 0x00, 0x28])
    XCTAssertEqual(
      [UInt8](avcDecoderConfiguration(sps: high, pps: pps)!.suffix(4)), [0xFD, 0xF8, 0xF8, 0])
    XCTAssertNil(avcDecoderConfiguration(sps: Data([0x67]), pps: pps))
    XCTAssertNil(avcDecoderConfiguration(sps: main, pps: Data()))
  }

  func testScaledSize() {
    let rows: [(Int, Int, Int, Int, Int)] = [
      (1920, 1080, 1920, 1920, 1080),
      (3456, 2234, 1920, 1920, 1240),
      (1179, 2556, 1920, 886, 1920),
      (1179, 2556, 4096, 1178, 2556),
      (1, 1, 1920, 2, 2),
    ]
    for (width, height, limit, expectedWidth, expectedHeight) in rows {
      let size = scaledSize(width: width, height: height, maxDimension: limit)
      XCTAssertEqual(size.width, expectedWidth, "\(width)x\(height)")
      XCTAssertEqual(size.height, expectedHeight, "\(width)x\(height)")
    }
  }

  func testArguments() throws {
    XCTAssertEqual(try parseArguments(["--list"]), .list)
    XCTAssertEqual(
      try parseArguments(["--source", "iphone", "--udid", "00008030-001C", "--port", "4100"]),
      .capture(CaptureOptions(source: .iphone(udid: "00008030-001C"), port: 4100)))
    var display = CaptureOptions(source: .display(id: 3), port: 4101)
    display.fps = 30
    display.maxDimension = 1280
    display.bitrateKbps = 4000
    XCTAssertEqual(
      try parseArguments([
        "--port", "4101", "--source", "display", "--display-id", "3", "--fps", "30",
        "--max-dimension", "1280", "--bitrate-kbps", "4000",
      ]), .capture(display))
    XCTAssertEqual(
      try parseArguments(["--source", "display", "--port", "1"]),
      .capture(CaptureOptions(source: .display(id: nil), port: 1)))

    let invalid: [[String]] = [
      [],
      ["--list", "--port", "1"],
      ["--source", "iphone", "--port", "1"],
      ["--source", "iphone", "--udid", "", "--port", "1"],
      ["--source", "iphone", "--udid", "x", "--display-id", "1", "--port", "1"],
      ["--source", "display", "--udid", "x", "--port", "1"],
      ["--source", "display"],
      ["--source", "display", "--port", "0"],
      ["--source", "display", "--port", "70000"],
      ["--source", "display", "--port"],
      ["--source", "display", "--port", "1", "--fps", "0"],
      ["--source", "display", "--port", "1", "--display-id", "-1"],
      ["--source", "window", "--port", "1"],
      ["--source", "display", "--port", "1", "--verbose"],
    ]
    for arguments in invalid {
      XCTAssertThrowsError(try parseArguments(arguments), "\(arguments)") { error in
        XCTAssertEqual((error as? CaptureError)?.code, .invalidArguments)
      }
    }
  }

  func testErrorLines() {
    XCTAssertEqual(
      CaptureError(.permissionMissing, "Off.", permission: "camera").jsonLine,
      #"{"code":"permission_missing","message":"Off.","permission":"camera","type":"error"}"#)
    XCTAssertEqual(
      CaptureError(.deviceNotTrusted, "Trust it.").jsonLine,
      #"{"code":"device_not_trusted","message":"Trust it.","type":"error"}"#)
    XCTAssertEqual(CaptureError(.invalidArguments, "").exitCode, 64)
    let codes: [CaptureError.Code] = [
      .permissionMissing, .deviceNotFound, .deviceNotTrusted, .deviceLocked, .unsupportedMacOS,
      .portUnavailable, .captureFailed,
    ]
    XCTAssertEqual(
      codes.map(\.rawValue),
      [
        "permission_missing", "device_not_found", "device_not_trusted", "device_locked",
        "unsupported_macos", "port_unavailable", "capture_failed",
      ])
    for code in codes { XCTAssertEqual(CaptureError(code, "").exitCode, 1) }
    XCTAssertEqual(normalizedUDID("00008030-001C2D3E"), "00008030001c2d3e")
  }
}
