import AVFoundation
import CoreMediaIO
import DeviceCaptureCore
import Foundation
import IOKit

/// A USB iPhone or iPad's screen, the way QuickTime records it: no app on the device, only Trust.
enum IPhoneSource {
  private final class FrameDelegate: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let onFrame: (CVPixelBuffer) -> Void
    init(_ onFrame: @escaping (CVPixelBuffer) -> Void) { self.onFrame = onFrame }

    func captureOutput(
      _ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
      from connection: AVCaptureConnection
    ) {
      if let frame = CMSampleBufferGetImageBuffer(sampleBuffer) { onFrame(frame) }
    }
  }

  private static var retained: [Any] = []

  /// iOS devices only show up as capture devices in a process that opts in to them.
  static func enableScreenCaptureDevices() {
    var address = CMIOObjectPropertyAddress(
      mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
      mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
      mElement: 0)
    var allow: UInt32 = 1
    CMIOObjectSetPropertyData(
      CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil,
      UInt32(MemoryLayout<UInt32>.size), &allow)
  }

  static func devices() -> [AVCaptureDevice] {
    let type: AVCaptureDevice.DeviceType
    if #available(macOS 14.0, *) { type = .external } else { type = .externalUnknown }
    return AVCaptureDevice.DiscoverySession(
      deviceTypes: [type], mediaType: .muxed, position: .unspecified
    ).devices
  }

  static func start(udid: String, queue: DispatchQueue, onFrame: @escaping (CVPixelBuffer) -> Void) {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      find(udid: udid, queue: queue, onFrame: onFrame)
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { granted in
        DispatchQueue.main.async {
          guard granted else { fail(cameraDenied) }
          find(udid: udid, queue: queue, onFrame: onFrame)
        }
      }
    default:
      fail(cameraDenied)
    }
  }

  private static let cameraDenied = CaptureError(
    .permissionMissing,
    "Camera access is off for this app. Allow it in System Settings > Privacy & Security > Camera.",
    permission: "camera")

  private static func find(
    udid: String, queue: DispatchQueue, onFrame: @escaping (CVPixelBuffer) -> Void
  ) {
    enableScreenCaptureDevices()
    let wanted = normalizedUDID(udid)
    let match = { devices().first { normalizedUDID($0.uniqueID) == wanted } }
    if let device = match() { return open(device, queue: queue, onFrame: onFrame) }

    // The device is announced a moment after capture devices are enabled.
    var observer: NSObjectProtocol?
    var settled = false
    let settle = { (device: AVCaptureDevice?) in
      guard !settled else { return }
      settled = true
      if let observer { NotificationCenter.default.removeObserver(observer) }
      if let device { return open(device, queue: queue, onFrame: onFrame) }
      if usbDeviceConnected(serial: wanted) {
        fail(
          CaptureError(
            .deviceNotTrusted,
            "The device is connected but not available for capture. Unlock it and tap Trust."))
      }
      fail(CaptureError(.deviceNotFound, "No USB device with UDID \(udid) is connected."))
    }
    observer = NotificationCenter.default.addObserver(
      forName: .AVCaptureDeviceWasConnected, object: nil, queue: .main
    ) { _ in if let device = match() { settle(device) } }
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { settle(match()) }
  }

  private static func open(
    _ device: AVCaptureDevice, queue: DispatchQueue, onFrame: @escaping (CVPixelBuffer) -> Void
  ) {
    let session = AVCaptureSession()
    let input: AVCaptureDeviceInput
    do {
      input = try AVCaptureDeviceInput(device: device)
    } catch {
      fail(
        CaptureError(
          .deviceLocked,
          "Could not open the device for capture. Unlock it and try again. (\(error.localizedDescription))"))
    }
    let output = AVCaptureVideoDataOutput()
    output.alwaysDiscardsLateVideoFrames = true
    output.videoSettings = [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    ]
    let delegate = FrameDelegate(onFrame)
    output.setSampleBufferDelegate(delegate, queue: queue)
    guard session.canAddInput(input), session.canAddOutput(output) else {
      fail(CaptureError(.captureFailed, "The device does not offer a video stream."))
    }
    session.addInput(input)
    session.addOutput(output)

    let center = NotificationCenter.default
    let disconnected = center.addObserver(
      forName: .AVCaptureDeviceWasDisconnected, object: device, queue: .main
    ) { _ in end("device_disconnected") }
    let failed = center.addObserver(
      forName: .AVCaptureSessionRuntimeError, object: session, queue: .main
    ) { note in
      let reason = (note.userInfo?[AVCaptureSessionErrorKey] as? NSError)?.localizedDescription
      fail(CaptureError(.captureFailed, "Device capture stopped: \(reason ?? "unknown error")."))
    }
    retained = [session, delegate, disconnected, failed]
    queue.async {
      session.startRunning()
      DispatchQueue.main.async { onCaptureStarted() }
    }
  }

  /// A phone that is plugged in but has not trusted this Mac is on USB without being a capture device.
  private static func usbDeviceConnected(serial: String) -> Bool {
    var iterator: io_iterator_t = 0
    guard
      IOServiceGetMatchingServices(0, IOServiceMatching("IOUSBHostDevice"), &iterator) == KERN_SUCCESS
    else { return false }
    defer { IOObjectRelease(iterator) }
    while case let service = IOIteratorNext(iterator), service != 0 {
      defer { IOObjectRelease(service) }
      let value = IORegistryEntryCreateCFProperty(
        service, "USB Serial Number" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
      if let found = value as? String, normalizedUDID(found) == serial { return true }
    }
    return false
  }
}
