import Foundation

public struct CaptureError: Error, Equatable {
  public enum Code: String {
    case invalidArguments = "invalid_arguments"
    case permissionMissing = "permission_missing"
    case deviceNotFound = "device_not_found"
    case deviceNotTrusted = "device_not_trusted"
    case deviceLocked = "device_locked"
    case unsupportedMacOS = "unsupported_macos"
    case portUnavailable = "port_unavailable"
    case captureFailed = "capture_failed"
  }

  public let code: Code
  public let message: String
  /// `camera` or `screen-recording`, when the code is `permission_missing`.
  public let permission: String?

  public init(_ code: Code, _ message: String, permission: String? = nil) {
    self.code = code
    self.message = message
    self.permission = permission
  }

  public var exitCode: Int32 { code == .invalidArguments ? 64 : 1 }

  public var jsonLine: String {
    var object: [String: Any] = ["type": "error", "code": code.rawValue, "message": message]
    if let permission { object["permission"] = permission }
    return encodeJSONLine(object)
  }
}

public func encodeJSONLine(_ object: [String: Any]) -> String {
  let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  return data.flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
}

public enum CaptureSource: Equatable {
  case iphone(udid: String)
  /// `nil` is the main display.
  case display(id: UInt32?)
}

public struct CaptureOptions: Equatable {
  public var source: CaptureSource
  public var port: UInt16
  public var fps = 60
  public var maxDimension = 1920
  /// `nil` derives a rate from the frame size.
  public var bitrateKbps: Int?
}

public enum Command: Equatable {
  case list
  case capture(CaptureOptions)
}

public let usage = """
  usage: t3-device-capture --list
         t3-device-capture --source iphone --udid <udid> --port <port> [options]
         t3-device-capture --source display [--display-id <id>] --port <port> [options]
  options: --fps <1-120> (60)  --max-dimension <320-4096> (1920)  --bitrate-kbps <200-100000>
  """

public func parseArguments(_ arguments: [String]) throws -> Command {
  func invalid(_ message: String) -> CaptureError { CaptureError(.invalidArguments, message) }
  var values: [String: String] = [:]
  var list = false
  var index = 0
  while index < arguments.count {
    let flag = arguments[index]
    index += 1
    if flag == "--list" {
      list = true
      continue
    }
    let known = [
      "--source", "--udid", "--display-id", "--port", "--fps", "--max-dimension", "--bitrate-kbps",
    ]
    guard known.contains(flag) else { throw invalid("Unknown argument \(flag).") }
    guard index < arguments.count else { throw invalid("\(flag) needs a value.") }
    values[flag] = arguments[index]
    index += 1
  }
  if list {
    guard values.isEmpty else { throw invalid("--list takes no other arguments.") }
    return .list
  }

  func integer(_ flag: String, _ range: ClosedRange<Int>) throws -> Int? {
    guard let raw = values[flag] else { return nil }
    guard let value = Int(raw), range.contains(value) else {
      throw invalid("\(flag) must be a whole number from \(range.lowerBound) to \(range.upperBound).")
    }
    return value
  }

  let source: CaptureSource
  switch values["--source"] {
  case "iphone":
    guard let udid = values["--udid"], !udid.isEmpty else {
      throw invalid("--source iphone needs --udid.")
    }
    guard values["--display-id"] == nil else {
      throw invalid("--display-id only applies to --source display.")
    }
    source = .iphone(udid: udid)
  case "display":
    guard values["--udid"] == nil else { throw invalid("--udid only applies to --source iphone.") }
    source = .display(id: try integer("--display-id", 0...Int(UInt32.max)).map { UInt32($0) })
  case nil:
    throw invalid("--source is required: iphone or display.")
  case let other?:
    throw invalid("Unknown source \(other): use iphone or display.")
  }
  guard let port = try integer("--port", 1...65535) else { throw invalid("--port is required.") }

  var options = CaptureOptions(source: source, port: UInt16(port))
  options.fps = try integer("--fps", 1...120) ?? options.fps
  options.maxDimension = try integer("--max-dimension", 320...4096) ?? options.maxDimension
  options.bitrateKbps = try integer("--bitrate-kbps", 200...100_000)
  return .capture(options)
}

/// AVFoundation and USB report a UDID without the dash Finder and Xcode print.
public func normalizedUDID(_ udid: String) -> String {
  udid.replacingOccurrences(of: "-", with: "").lowercased()
}
