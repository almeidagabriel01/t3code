// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "t3-device-capture",
  // ScreenCaptureKit needs 12.3; the lower target lets the helper report that itself.
  platforms: [.macOS(.v11)],
  targets: [
    .target(name: "DeviceCaptureCore"),
    .executableTarget(name: "t3-device-capture", dependencies: ["DeviceCaptureCore"]),
    .testTarget(name: "DeviceCaptureCoreTests", dependencies: ["DeviceCaptureCore"]),
  ],
  swiftLanguageVersions: [.v5]
)
