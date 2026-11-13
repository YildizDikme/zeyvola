// swift-tools-version:5.9
// Zeyvola macOS recording helper. Apple system frameworks only; no third-party packages.
import PackageDescription

let package = Package(
    name: "ZeyvolaRecorder",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "zeyvola-recorder",
            path: "Sources/ZeyvolaRecorder",
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("CoreVideo"),
                .linkedFramework("AppKit"),
            ]
        ),
    ]
)
