import CoreMedia
import Foundation
import VideoToolbox

public struct EncodedFrame {
  /// The `avcC` record; present on every keyframe.
  public let description: Data?
  public let isKeyframe: Bool
  /// NAL units, each behind a 4-byte big-endian length.
  public let data: Data
  public let width: Int
  public let height: Int
}

/// Real-time H.264 without frame reordering. Call it from one queue; output arrives on VideoToolbox's.
public final class H264Encoder {
  private let fps: Int
  private let maxDimension: Int
  private let bitrateKbps: Int?
  private let onOutput: (EncodedFrame) -> Void
  private var session: VTCompressionSession?
  private var inputSize = (width: 0, height: 0)
  private var outputSize = (width: 0, height: 0)

  public init(
    fps: Int,
    maxDimension: Int,
    bitrateKbps: Int? = nil,
    onOutput: @escaping (EncodedFrame) -> Void
  ) {
    self.fps = fps
    self.maxDimension = maxDimension
    self.bitrateKbps = bitrateKbps
    self.onOutput = onOutput
  }

  deinit { invalidate() }

  /// Returns false when VideoToolbox refuses the frame.
  @discardableResult
  public func encode(_ pixelBuffer: CVPixelBuffer, forceKeyframe: Bool) -> Bool {
    let width = CVPixelBufferGetWidth(pixelBuffer)
    let height = CVPixelBufferGetHeight(pixelBuffer)
    // A rotated phone or a resized display changes the frame: start over with a new description.
    if session == nil || inputSize.width != width || inputSize.height != height {
      invalidate()
      inputSize = (width, height)
      outputSize = scaledSize(width: width, height: height, maxDimension: maxDimension)
      session = makeSession()
    }
    guard let session else { return false }
    let size = outputSize
    let properties =
      forceKeyframe ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
    let status = VTCompressionSessionEncodeFrame(
      session,
      imageBuffer: pixelBuffer,
      // Host time keeps timestamps increasing when a frame is encoded again for a new viewer.
      presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()),
      duration: .invalid,
      frameProperties: properties,
      infoFlagsOut: nil
    ) { [onOutput] status, _, sampleBuffer in
      guard status == noErr, let sampleBuffer,
        let frame = encodedFrame(sampleBuffer, width: size.width, height: size.height)
      else { return }
      onOutput(frame)
    }
    return status == noErr
  }

  /// Blocks until every submitted frame has reached `onOutput`.
  public func flush() {
    if let session { VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid) }
  }

  public func invalidate() {
    if let session {
      VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
      VTCompressionSessionInvalidate(session)
    }
    session = nil
  }

  private func makeSession() -> VTCompressionSession? {
    func create(_ specification: CFDictionary?) -> VTCompressionSession? {
      var created: VTCompressionSession?
      let status = VTCompressionSessionCreate(
        allocator: nil,
        width: Int32(outputSize.width),
        height: Int32(outputSize.height),
        codecType: kCMVideoCodecType_H264,
        encoderSpecification: specification,
        imageBufferAttributes: nil,
        compressedDataAllocator: nil,
        outputCallback: nil,
        refcon: nil,
        compressionSessionOut: &created
      )
      return status == noErr ? created : nil
    }
    var session: VTCompressionSession?
    if #available(macOS 11.3, *) {
      // Low-latency rate control emits each frame as it arrives; not every encoder offers it.
      session = create(
        [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true] as CFDictionary)
    }
    guard let session = session ?? create(nil) else { return nil }
    let pixels = outputSize.width * outputSize.height
    let bitrate = (bitrateKbps.map { $0 * 1000 }) ?? min(20_000_000, max(2_000_000, pixels * fps / 12))
    let properties: [CFString: Any] = [
      kVTCompressionPropertyKey_RealTime: true,
      kVTCompressionPropertyKey_AllowFrameReordering: false,
      kVTCompressionPropertyKey_ProfileLevel: kVTProfileLevel_H264_High_AutoLevel,
      kVTCompressionPropertyKey_ExpectedFrameRate: fps,
      kVTCompressionPropertyKey_AverageBitRate: bitrate,
      // New viewers force their own keyframe, so periodic ones only bound recovery time.
      kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: 5,
      kVTCompressionPropertyKey_MaxKeyFrameInterval: fps * 5,
    ]
    // Set one by one: an encoder that lacks a property still takes the others.
    for (key, value) in properties {
      VTSessionSetProperty(session, key: key, value: value as CFTypeRef)
    }
    VTCompressionSessionPrepareToEncodeFrames(session)
    return session
  }
}

private func encodedFrame(_ sampleBuffer: CMSampleBuffer, width: Int, height: Int) -> EncodedFrame? {
  guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return nil }
  let length = CMBlockBufferGetDataLength(block)
  var data = Data(count: length)
  let copied = data.withUnsafeMutableBytes { bytes -> OSStatus in
    guard let base = bytes.baseAddress else { return -1 }
    return CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: base)
  }
  guard copied == noErr, length > 0 else { return nil }

  let attachments =
    CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
    as? [[CFString: Any]]
  let isKeyframe = !((attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false)
  var description: Data?
  if isKeyframe {
    guard let format = CMSampleBufferGetFormatDescription(sampleBuffer),
      let record = decoderConfiguration(format)
    else { return nil }
    description = record
  }
  return EncodedFrame(
    description: description, isKeyframe: isKeyframe, data: data, width: width, height: height)
}

private func decoderConfiguration(_ format: CMFormatDescription) -> Data? {
  func parameterSet(_ index: Int) -> Data? {
    var pointer: UnsafePointer<UInt8>?
    var size = 0
    var nalLength: Int32 = 0
    let status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
      format, parameterSetIndex: index, parameterSetPointerOut: &pointer,
      parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: &nalLength)
    // The record below declares 4-byte lengths, which is what VideoToolbox writes.
    guard status == noErr, nalLength == 4, let pointer else { return nil }
    return Data(bytes: pointer, count: size)
  }
  guard let sps = parameterSet(0), let pps = parameterSet(1) else { return nil }
  return avcDecoderConfiguration(sps: sps, pps: pps)
}
