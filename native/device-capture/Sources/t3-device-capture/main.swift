import AVFoundation
import CoreGraphics
import DeviceCaptureCore
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ object: [String: Any]) {
  print(encodeJSONLine(object))
}

func fail(_ error: CaptureError) -> Never {
  print(error.jsonLine)
  exit(error.exitCode)
}

/// The capture ended on its own: the phone was unplugged or the display went away.
func end(_ reason: String) -> Never {
  emit(["type": "ended", "reason": reason])
  exit(0)
}

/// Sources call this on the main queue once capture is running, past any prompt or device lookup.
var onCaptureStarted: () -> Void = {}

func cameraPermission() -> String {
  switch AVCaptureDevice.authorizationStatus(for: .video) {
  case .authorized: return "granted"
  case .notDetermined: return "not_determined"
  default: return "denied"
  }
}

func list() -> Never {
  // Connected phones are announced shortly after capture devices are enabled; listing never prompts.
  IPhoneSource.enableScreenCaptureDevices()
  DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
    let displays = activeDisplays().map { id -> [String: Any] in
      [
        "id": Int(id), "width": CGDisplayPixelsWide(id), "height": CGDisplayPixelsHigh(id),
        "main": CGDisplayIsMain(id) != 0,
      ]
    }
    emit([
      "type": "list",
      "iphones": IPhoneSource.devices().map {
        ["udid": $0.uniqueID, "name": $0.localizedName, "model": $0.modelID]
      },
      "displays": displays,
      "permissions": [
        "camera": cameraPermission(),
        "screenRecording": CGPreflightScreenCaptureAccess() ? "granted" : "denied",
      ],
      "displayCaptureSupported": displayCaptureSupported,
    ])
    exit(0)
  }
  RunLoop.main.run()
  exit(0)
}

func activeDisplays() -> [CGDirectDisplayID] {
  var count: UInt32 = 0
  CGGetActiveDisplayList(0, nil, &count)
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  CGGetActiveDisplayList(count, &ids, &count)
  return Array(ids.prefix(Int(count)))
}

var displayCaptureSupported: Bool {
  if #available(macOS 12.3, *) { return true }
  return false
}

func capture(_ options: CaptureOptions) -> Never {
  let captureQueue = DispatchQueue(label: "t3.device-capture.frames")
  var lastFrame: CVPixelBuffer?
  var lastEncode = DispatchTime.now()
  var keyframeWanted = true
  var port: UInt16?
  var readyAnnounced = false
  let sourceName: String
  if case .iphone = options.source { sourceName = "iphone" } else { sourceName = "display" }

  var server: StreamServer!
  let encoder = H264Encoder(
    fps: options.fps, maxDimension: options.maxDimension, bitrateKbps: options.bitrateKbps
  ) { frame in
    server.broadcast(frame)
    DispatchQueue.main.async {
      guard !readyAnnounced, let port else { return }
      readyAnnounced = true
      emit([
        "type": "ready", "pid": Int(getpid()), "port": Int(port), "source": sourceName,
        "width": frame.width, "height": frame.height, "streamPath": "/stream.avcc",
      ])
    }
  }

  // Runs on the capture queue.
  func encode(_ frame: CVPixelBuffer) {
    lastFrame = frame
    lastEncode = .now()
    if !encoder.encode(frame, forceKeyframe: keyframeWanted) {
      fail(CaptureError(.captureFailed, "The H.264 encoder refused a frame."))
    }
    keyframeWanted = false
  }

  server = StreamServer(port: options.port) {
    captureQueue.async {
      keyframeWanted = true
      // A still screen sends no new frame, so the last one is encoded again as the keyframe.
      if let lastFrame { encode(lastFrame) }
    }
  }

  // A still screen produces no frames; viewers treat a silent stream as stalled.
  let heartbeat = DispatchSource.makeTimerSource(queue: captureQueue)
  heartbeat.schedule(deadline: .now() + 1, repeating: 1)
  heartbeat.setEventHandler {
    if let lastFrame, DispatchTime.now().uptimeNanoseconds - lastEncode.uptimeNanoseconds > 900_000_000 {
      encode(lastFrame)
    }
  }
  heartbeat.resume()

  var signals: [DispatchSourceSignal] = []
  for number in [SIGTERM, SIGINT] {
    signal(number, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
    source.setEventHandler {
      server.stop()
      exit(0)
    }
    source.resume()
    signals.append(source)
  }
  // The server that started this helper owns it: never outlive it.
  let parent = DispatchSource.makeProcessSource(identifier: getppid(), eventMask: .exit, queue: .main)
  parent.setEventHandler { exit(0) }
  parent.resume()

  server.start { result in
    DispatchQueue.main.async {
      switch result {
      case .failure(let error):
        fail(CaptureError(.portUnavailable, "Could not listen on 127.0.0.1:\(options.port): \(error.localizedDescription)"))
      case .success(let bound):
        port = bound
        onCaptureStarted = {
          DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
            guard !readyAnnounced else { return }
            if case .iphone = options.source {
              fail(CaptureError(.deviceLocked, "The device sent no video. Unlock it and keep it awake."))
            }
            fail(CaptureError(.captureFailed, "The display sent no video."))
          }
        }
        let onFrame: (CVPixelBuffer) -> Void = { encode($0) }
        switch options.source {
        case .iphone(let udid):
          IPhoneSource.start(udid: udid, queue: captureQueue, onFrame: onFrame)
        case .display(let id):
          guard #available(macOS 12.3, *) else {
            fail(CaptureError(.unsupportedMacOS, "Display capture needs macOS 12.3 or later."))
          }
          DisplaySource.start(displayID: id, options: options, queue: captureQueue, onFrame: onFrame)
        }
      }
    }
  }
  withExtendedLifetime((heartbeat, signals, parent)) { RunLoop.main.run() }
  exit(0)
}

do {
  switch try parseArguments(Array(CommandLine.arguments.dropFirst())) {
  case .list: list()
  case .capture(let options): capture(options)
  }
} catch let error as CaptureError {
  FileHandle.standardError.write(Data((usage + "\n").utf8))
  fail(error)
}
