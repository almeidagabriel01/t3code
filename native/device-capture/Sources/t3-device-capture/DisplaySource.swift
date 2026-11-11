import CoreGraphics
import DeviceCaptureCore
import Foundation
import IOKit.pwr_mgt
import ScreenCaptureKit

@available(macOS 12.3, *)
enum DisplaySource {
  private final class Output: NSObject, SCStreamOutput, SCStreamDelegate {
    let onFrame: (CVPixelBuffer) -> Void
    init(_ onFrame: @escaping (CVPixelBuffer) -> Void) { self.onFrame = onFrame }

    func stream(
      _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
      of type: SCStreamOutputType
    ) {
      guard type == .screen,
        let attachments = CMSampleBufferGetSampleAttachmentsArray(
          sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
        let raw = attachments.first?[.status] as? Int,
        SCFrameStatus(rawValue: raw) == .complete,
        let frame = CMSampleBufferGetImageBuffer(sampleBuffer)
      else { return }
      onFrame(frame)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
      DispatchQueue.main.async { end("display_stopped") }
    }
  }

  private static var retained: [Any] = []
  /** Held until the process exits, which releases it: the screen stays on while it streams. */
  private static var keepAwake: IOPMAssertionID = 0

  /** Wakes a sleeping display, as remote-desktop tools do: a sleeping one is not capturable. */
  private static func wakeDisplay() {
    var activity: IOPMAssertionID = 0
    _ = IOPMAssertionDeclareUserActivity(
      "T3 Code is showing this screen" as CFString, kIOPMUserActiveLocal, &activity)
    if keepAwake == 0 {
      _ = IOPMAssertionCreateWithName(
        kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
        IOPMAssertionLevel(kIOPMAssertionLevelOn),
        "T3 Code is streaming this screen" as CFString, &keepAwake)
    }
  }

  private static let permissionMissing = CaptureError(
    .permissionMissing,
    "Screen Recording is off for this app. Allow it in System Settings > Privacy & Security > Screen & System Audio Recording, then restart the app.",
    permission: "screen-recording")

  static func start(
    displayID: UInt32?, options: CaptureOptions, queue: DispatchQueue,
    onFrame: @escaping (CVPixelBuffer) -> Void
  ) {
    guard CGPreflightScreenCaptureAccess() else {
      // Asks once and lists the app in System Settings; the grant applies from the next launch.
      _ = CGRequestScreenCaptureAccess()
      fail(permissionMissing)
    }
    wakeDisplay()
    findDisplay(displayID ?? CGMainDisplayID(), attempt: 0) { wanted, display in
      let mode = CGDisplayCopyDisplayMode(wanted)
      let size = scaledSize(
        width: mode?.pixelWidth ?? display.width, height: mode?.pixelHeight ?? display.height,
        maxDimension: options.maxDimension)
      let configuration = SCStreamConfiguration()
      configuration.width = size.width
      configuration.height = size.height
      configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(options.fps))
      configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
      configuration.showsCursor = true
      configuration.queueDepth = 5

      let output = Output(onFrame)
      let stream = SCStream(
        filter: SCContentFilter(display: display, excludingWindows: []),
        configuration: configuration, delegate: output)
      do {
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: queue)
      } catch {
        fail(CaptureError(.captureFailed, "Could not attach to the display: \(error.localizedDescription)."))
      }
      retained = [stream, output]
      stream.startCapture { error in
        guard let error else { return DispatchQueue.main.async { onCaptureStarted() } }
        DispatchQueue.main.async {
          // -3801: the user declined, or the grant was removed since launch.
          if (error as NSError).code == -3801 { fail(permissionMissing) }
          fail(CaptureError(.captureFailed, "Display capture did not start: \(error.localizedDescription)."))
        }
      }
    }
  }

  /** A display that was asleep reappears in the shareable content a moment after it wakes. */
  private static func findDisplay(
    _ wanted: CGDirectDisplayID, attempt: Int,
    found: @escaping (CGDirectDisplayID, SCDisplay) -> Void
  ) {
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
      DispatchQueue.main.async {
        guard let content else {
          fail(
            CaptureError(
              .captureFailed,
              "Could not read the displays: \(error?.localizedDescription ?? "unknown error")."))
        }
        if let display = content.displays.first(where: { $0.displayID == wanted }) {
          return found(wanted, display)
        }
        let asleep = CGDisplayIsAsleep(wanted) != 0
        if asleep || CGDisplayIsActive(wanted) == 0, attempt < 20 {
          return DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            findDisplay(wanted, attempt: attempt + 1, found: found)
          }
        }
        fail(
          asleep
            ? CaptureError(
              .captureFailed, "The screen is asleep and did not wake. Wake the computer, then open it again.")
            : CaptureError(.deviceNotFound, "No display with id \(wanted) is connected."))
      }
    }
  }
}
