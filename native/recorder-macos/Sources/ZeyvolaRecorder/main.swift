import AppKit
import AVFoundation
import CoreGraphics
import Foundation

// Zeyvola macOS recording helper.
//
// Started by the Zeyvola app; records only after the user presses "Kaydı başlat" there.
// Uses ScreenCaptureKit and AVFoundation, so macOS asks for permission with its own dialogs
// and shows its recording indicator. The keyboard is never read. Files are written to the
// project folder on the local disk only; nothing is sent over the network.

let version = "0.1.0"

func architecture() -> String {
    #if arch(arm64)
    return "arm64"
    #else
    return "x86_64"
    #endif
}

func authorization(_ type: AVMediaType) -> String {
    switch AVCaptureDevice.authorizationStatus(for: type) {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not-determined"
    @unknown default: return "unknown"
    }
}

let arguments = CommandLine.arguments
if arguments.contains("--version") {
    print(version)
    exit(0)
}
if arguments.contains("--probe") {
    // Permission state only; nothing is captured.
    let probe: [String: Any] = [
        "version": version, "arch": architecture(), "os": ProcessInfo.processInfo.operatingSystemVersionString,
        "screen": CGPreflightScreenCaptureAccess() ? "granted" : "not-granted",
        "camera": authorization(.video), "mic": authorization(.audio),
    ]
    Output.send(probe)
    exit(0)
}
if let i = arguments.firstIndex(of: "--probe-files") {
    // Playable length of each recorded file in a folder (crash recovery); nothing is captured.
    guard i + 1 < arguments.count else {
        Output.send(["type": "probe", "error": "usage: --probe-files <dir>"])
        exit(2)
    }
    exit(FileProbe.run(directory: arguments[i + 1]) ? 0 : 1)
}
if let i = arguments.firstIndex(of: "--extract-audio") {
    // Sound of a video added from the computer, re-encoded to Opus by macOS; nothing is captured.
    guard i + 2 < arguments.count else {
        Output.send(["type": "audio", "error": "usage: --extract-audio <video> <out.m4a>"])
        exit(2)
    }
    exit(AudioExtract.run(input: arguments[i + 1], output: arguments[i + 2]) ? 0 : 1)
}
if arguments.contains("--self-test") {
    exit(SelfTest.run() ? 0 : 1)
}

let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
let controller = Controller()
controller.run()
Output.send(["type": "hello", "version": version, "arch": architecture()])
application.run()
