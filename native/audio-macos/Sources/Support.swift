import AVFoundation
import Foundation

// The few pieces of the recording helper that AudioExtract.swift uses.

enum Output {
    static func send(_ object: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}

struct RecorderError: Error, CustomStringConvertible {
    let code: String
    let message: String
    init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
    var description: String { "\(code): \(message)" }
}

/// Audio output settings: Opus, or 16-bit PCM where this macOS cannot write Opus.
enum TrackWriter {
    static func opusSettings(sampleRate: Double, channels: Int, bitrate: Int) -> [String: Any] {
        [AVFormatIDKey: kAudioFormatOpus, AVSampleRateKey: sampleRate, AVNumberOfChannelsKey: channels, AVEncoderBitRateKey: bitrate]
    }

    static func pcmSettings(sampleRate: Double, channels: Int) -> [String: Any] {
        [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: sampleRate, AVNumberOfChannelsKey: channels,
         AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false]
    }
}
