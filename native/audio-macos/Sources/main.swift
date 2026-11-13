import Foundation

// Zeyvola audio helper (macOS).
//
//   zeyvola-audio --extract-audio <video> <out.m4a>
//
// Sound of a video added from the computer: if Zeyvola's media library cannot decode it (AAC and
// similar), macOS decodes it and writes it again as Opus (or 16-bit PCM) with its own encoder.
// The extraction code is shared with the recording helper (../recorder-macos/.../AudioExtract.swift).
// This program records nothing, encodes no video, makes no network requests and links only
// Foundation, AVFoundation and CoreMedia. Answers one JSON line (see AudioExtract).

let arguments = CommandLine.arguments
if let i = arguments.firstIndex(of: "--extract-audio") {
    guard i + 2 < arguments.count else {
        Output.send(["type": "audio", "error": "usage: --extract-audio <video> <out.m4a>"])
        exit(2)
    }
    exit(AudioExtract.run(input: arguments[i + 1], output: arguments[i + 2]) ? 0 : 1)
}
if arguments.contains("--version") {
    Output.send(["type": "version", "version": "0.1.0"])
    exit(0)
}
Output.send(["type": "error", "code": "usage", "message": "--extract-audio <video> <out.m4a>"])
exit(64)
