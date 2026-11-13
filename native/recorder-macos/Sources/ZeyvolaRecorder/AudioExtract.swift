import AVFoundation
import CoreMedia
import Foundation

/// Sound of a video added from the computer, for builds whose Chromium has no AAC decoder
/// (Electron's libffmpeg without proprietary codecs). If the first audio track is in a format
/// that build cannot decode (AAC, ALAC, …), it is decoded by macOS and written again as Opus
/// in MP4 with macOS's own encoder, next to the copied video. Nothing is sent anywhere.
///
///   zeyvola-recorder --extract-audio <video> <out.m4a>
///   → {"type":"audio","audio":false} | {"type":"audio","audio":true,"converted":false,"codec":"opus"}
///   → {"type":"audio","audio":true,"converted":true,"file":…,"codec":"opus"|"pcm","durationMs":…}
enum AudioExtract {
    /// Formats Electron's codec-free libffmpeg decodes itself (no conversion needed).
    static let decodable: Set<AudioFormatID> = [kAudioFormatOpus, kAudioFormatFLAC, kAudioFormatLinearPCM, kAudioFormatMPEGLayer3]

    static func run(input: String, output: String) -> Bool {
        let result = extract(input: URL(fileURLWithPath: input), output: URL(fileURLWithPath: output))
        Output.send(result)
        return result["error"] == nil
    }

    static func extract(input: URL, output: URL) -> [String: Any] {
        var out: [String: Any] = ["type": "audio"]
        let asset = AVURLAsset(url: input)
        guard let (track, format) = firstAudioTrack(asset) else { out["audio"] = false; return out }
        out["audio"] = true
        let subtype = CMFormatDescriptionGetMediaSubType(format)
        if decodable.contains(subtype) {
            out["converted"] = false
            out["codec"] = fourcc(subtype)
            return out
        }
        let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee
        let channels = min(2, max(1, Int(asbd?.mChannelsPerFrame ?? 2)))
        do {
            try? FileManager.default.removeItem(at: output)
            let reader = try AVAssetReader(asset: asset)
            let decoded = AVAssetReaderTrackOutput(track: track, outputSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: channels,
                AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
            ])
            guard reader.canAdd(decoded) else { throw RecorderError("extract", "ses çözülemiyor") }
            reader.add(decoded)
            let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
            var input = AVAssetWriterInput(mediaType: .audio, outputSettings: TrackWriter.opusSettings(sampleRate: 48_000, channels: channels, bitrate: 160_000))
            var codec = "opus"
            if !writer.canAdd(input) {
                input = AVAssetWriterInput(mediaType: .audio, outputSettings: TrackWriter.pcmSettings(sampleRate: 48_000, channels: channels))
                codec = "pcm"
            }
            input.expectsMediaDataInRealTime = false
            guard writer.canAdd(input) else { throw RecorderError("extract", "ses yazılamıyor") }
            writer.add(input)
            guard reader.startReading() else { throw reader.error ?? RecorderError("extract", "okuma başlamadı") }
            guard writer.startWriting() else { throw writer.error ?? RecorderError("extract", "yazma başlamadı") }
            // Sample times stay as in the video, so the sound keeps its place against the picture.
            writer.startSession(atSourceTime: .zero)
            var last = CMTime.zero
            while let sample = decoded.copyNextSampleBuffer() {
                while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
                last = CMTimeAdd(CMSampleBufferGetPresentationTimeStamp(sample), CMSampleBufferGetDuration(sample))
                if !input.append(sample) { throw writer.error ?? RecorderError("extract", "ses eklenemedi") }
            }
            if reader.status == .failed { throw reader.error ?? RecorderError("extract", "okuma yarıda kaldı") }
            input.markAsFinished()
            writer.endSession(atSourceTime: last)
            let done = DispatchSemaphore(value: 0)
            writer.finishWriting { done.signal() }
            done.wait()
            guard writer.status == .completed else { throw writer.error ?? RecorderError("extract", "dosya kapanmadı") }
            out["converted"] = true
            out["file"] = output.path
            out["codec"] = codec
            out["from"] = fourcc(subtype)
            out["durationMs"] = CMTimeGetSeconds(last) * 1000
        } catch {
            try? FileManager.default.removeItem(at: output)
            out["error"] = "\(error)"
        }
        return out
    }

    private static func firstAudioTrack(_ asset: AVURLAsset) -> (AVAssetTrack, CMFormatDescription)? {
        let done = DispatchSemaphore(value: 0)
        var found: (AVAssetTrack, CMFormatDescription)?
        Task {
            if let track = try? await asset.loadTracks(withMediaType: .audio).first,
               let desc = try? await track.load(.formatDescriptions).first {
                found = (track, desc)
            }
            done.signal()
        }
        done.wait()
        return found
    }

    private static func fourcc(_ id: AudioFormatID) -> String {
        switch id {
        case kAudioFormatOpus: return "opus"
        case kAudioFormatFLAC: return "flac"
        case kAudioFormatLinearPCM: return "pcm"
        case kAudioFormatMPEGLayer3: return "mp3"
        case kAudioFormatMPEG4AAC: return "aac"
        default:
            let b = [24, 16, 8, 0].map { UInt8((id >> $0) & 0xff) }
            return String(bytes: b, encoding: .ascii)?.trimmingCharacters(in: .whitespaces) ?? "\(id)"
        }
    }
}
