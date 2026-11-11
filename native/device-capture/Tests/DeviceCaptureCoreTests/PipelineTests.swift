import CoreVideo
import XCTest

@testable import DeviceCaptureCore

/// Real VideoToolbox and a real socket, fed synthetic frames: no capture and no permission prompt.
final class PipelineTests: XCTestCase {
  private var server: StreamServer!
  private var encoder: H264Encoder!
  private var port: UInt16 = 0
  private let frames = DispatchQueue(label: "test.frames")

  override func setUpWithError() throws {
    let frame = try XCTUnwrap(makeFrame(width: 640, height: 360))
    encoder = H264Encoder(fps: 30, maxDimension: 320) { [unowned self] in self.server.broadcast($0) }
    // Each viewer gets a forced keyframe and one delta, as the helper does for a still screen.
    server = StreamServer(port: 0) { [unowned self] in
      self.frames.async {
        XCTAssertTrue(self.encoder.encode(frame, forceKeyframe: true))
        XCTAssertTrue(self.encoder.encode(frame, forceKeyframe: false))
      }
    }
    let ready = DispatchSemaphore(value: 0)
    var result: Result<UInt16, Error>?
    server.start {
      result = $0
      ready.signal()
    }
    ready.wait()
    port = try XCTUnwrap(result).get()
  }

  override func tearDown() {
    server.stop()
    frames.sync { encoder.invalidate() }
  }

  func testNewViewersStartWithDescriptionAndKeyframe() throws {
    func join() throws -> Int32 {
      let socket = try connect("127.0.0.1")
      let head = try request(socket, "GET /stream.avcc?x=1 HTTP/1.1")
      XCTAssertTrue(head.hasPrefix("HTTP/1.1 200 OK"), head)
      XCTAssertTrue(head.contains("Content-Type: application/octet-stream"), head)

      let chunks = try readChunks(socket, count: 3)
      XCTAssertEqual(chunks.map(\.tag), [1, 2, 3])
      let description = chunks[0].payload
      XCTAssertEqual(description[0], 1)
      XCTAssertEqual(description[4], 0xFF, "4-byte NAL lengths")
      // The description's SPS repeats the profile bytes the viewer builds its codec string from.
      XCTAssertEqual(Array(description[1...3]), Array(description[9...11]))

      for chunk in chunks.dropFirst() {
        var offset = 0
        var types: [UInt8] = []
        while offset + 4 <= chunk.payload.count {
          let length = chunk.payload[offset..<offset + 4].reduce(0) { $0 << 8 | Int($1) }
          types.append(chunk.payload[offset + 4] & 0x1F)
          offset += 4 + length
        }
        XCTAssertEqual(offset, chunk.payload.count, "NAL lengths cover the payload")
        XCTAssertEqual(types.contains(5), chunk.tag == 2, "IDR slices only in keyframes")
      }
      return socket
    }
    let first = try join()
    defer { close(first) }
    let second = try join()
    defer { close(second) }
    // The second viewer's keyframe reaches the first without a description: its decoder is not reset.
    XCTAssertEqual(try readChunks(first, count: 5).map(\.tag), [1, 2, 3, 2, 3])
  }

  func testConfigHealthAndRefusals() throws {
    let rows: [(String, String, String)] = [
      ("GET /health HTTP/1.1", "200 OK", #"{"status":"ok"}"#),
      ("GET /config HTTP/1.1", "503 Service Unavailable", #"{"error":"no_frame"}"#),
      ("GET /other HTTP/1.1", "404 Not Found", #"{"error":"not_found"}"#),
      ("POST /stream.avcc HTTP/1.1", "405 Method Not Allowed", #"{"error":"method_not_allowed"}"#),
    ]
    for (line, status, body) in rows {
      let socket = try connect("127.0.0.1")
      defer { close(socket) }
      let head = try request(socket, line)
      XCTAssertTrue(head.hasPrefix("HTTP/1.1 \(status)"), head)
      XCTAssertEqual(String(decoding: try readToEnd(socket), as: UTF8.self), body)
    }

    let viewer = try connect("127.0.0.1")
    defer { close(viewer) }
    _ = try request(viewer, "GET /stream.avcc HTTP/1.1")
    _ = try readChunks(viewer, count: 2)
    let socket = try connect("127.0.0.1")
    defer { close(socket) }
    _ = try request(socket, "GET /config HTTP/1.1")
    XCTAssertEqual(
      String(decoding: try readToEnd(socket), as: UTF8.self),
      #"{"height":180,"inputUnavailable":true,"keyboardUnavailable":true,"orientation":"landscape_left","width":320}"#)
  }

  func testListensOnLoopbackOnly() throws {
    guard let address = externalIPv4() else { throw XCTSkip("No non-loopback IPv4 interface.") }
    XCTAssertThrowsError(try connect(address))
  }

  // MARK: helpers

  private func makeFrame(width: Int, height: Int) -> CVPixelBuffer? {
    var buffer: CVPixelBuffer?
    CVPixelBufferCreate(
      nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary] as CFDictionary, &buffer)
    return buffer
  }

  private func connect(_ host: String) throws -> Int32 {
    let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = port.bigEndian
    inet_pton(AF_INET, host, &address.sin_addr)
    let status = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard status == 0 else {
      close(socket)
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .ECONNREFUSED)
    }
    return socket
  }

  private var leftover: [Int32: [UInt8]] = [:]

  private func read(_ socket: Int32) throws -> [UInt8] {
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    let count = recv(socket, &buffer, buffer.count, 0)
    guard count >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    return Array(buffer.prefix(count))
  }

  /// Sends a request and returns the response head; body bytes already read wait in `leftover`.
  private func request(_ socket: Int32, _ line: String) throws -> String {
    let bytes = Array("\(line)\r\nHost: localhost\r\n\r\n".utf8)
    XCTAssertEqual(send(socket, bytes, bytes.count, 0), bytes.count)
    var received: [UInt8] = []
    let terminator = Array("\r\n\r\n".utf8)
    while true {
      if let end = received.indices.first(where: { received[$0...].starts(with: terminator) }) {
        leftover[socket] = Array(received[(end + 4)...])
        return String(decoding: received[..<end], as: UTF8.self)
      }
      let more = try read(socket)
      guard !more.isEmpty else { throw POSIXError(.ECONNRESET) }
      received += more
    }
  }

  private func readChunks(_ socket: Int32, count: Int) throws -> [(tag: UInt8, payload: [UInt8])] {
    var body = leftover[socket] ?? []
    while demux(body).count < count {
      let more = try read(socket)
      guard !more.isEmpty else { throw POSIXError(.ECONNRESET) }
      body += more
    }
    leftover[socket] = body
    return Array(demux(body).prefix(count))
  }

  private func readToEnd(_ socket: Int32) throws -> [UInt8] {
    var body = leftover[socket] ?? []
    while true {
      let more = try read(socket)
      if more.isEmpty { return body }
      body += more
    }
  }

  private func externalIPv4() -> String? {
    var list: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&list) == 0 else { return nil }
    defer { freeifaddrs(list) }
    var cursor = list
    while let entry = cursor {
      defer { cursor = entry.pointee.ifa_next }
      guard let address = entry.pointee.ifa_addr, address.pointee.sa_family == sa_family_t(AF_INET),
        entry.pointee.ifa_flags & UInt32(IFF_LOOPBACK) == 0,
        entry.pointee.ifa_flags & UInt32(IFF_UP) != 0
      else { continue }
      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
      return String(cString: host)
    }
    return nil
  }
}
