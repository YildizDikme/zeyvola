import AVFoundation
import CoreMedia
import CoreVideo
import Foundation

/// Writes one source (screen, camera, microphone or system audio) into its own file.
/// All calls must come from the source's sample queue, which keeps appends ordered.
/// The file starts at the first accepted sample; `firstTime` (session seconds) becomes the
/// source's start offset in the project, so every file lines up on the recording clock.
/// Opening the file also records it in the session log, for recovery after a crash.
final class TrackWriter {
    enum Kind {
        /// Width and height come from the first frame, so a camera that changes format still fits.
        case video(fps: Int, quality: String)
        case audio(sampleRate: Double, channels: Int, bitrate: Int)
    }

    let source: String      // "screen" | "camera" | "mic" | "system"
    let fileName: String
    let mime: String
    let kind: Kind
    let queue: DispatchQueue
    private let url: URL
    private let log: SessionLog?

    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private(set) var firstTime: Double?
    private var lastTime: Double = -1
    private var videoSize = (width: 0, height: 0)
    private(set) var appended = 0
    private(set) var dropped = 0
    private(set) var failure: String?

    init(source: String, fileName: String, mime: String, directory: URL, kind: Kind, queue: DispatchQueue, log: SessionLog? = nil) {
        self.source = source
        self.fileName = fileName
        self.mime = mime
        self.kind = kind
        self.queue = queue
        self.url = directory.appendingPathComponent(fileName)
        self.log = log
    }

    /// Kind, name, mime and format of the file (shared by the session log and "stopped").
    private func describe() -> [String: Any] {
        var info: [String: Any] = ["kind": source, "name": fileName, "mime": mime]
        switch kind {
        case let .video(fps, _):
            info["width"] = videoSize.width
            info["height"] = videoSize.height
            info["fps"] = fps
        case let .audio(sampleRate, channels, _):
            info["sampleRate"] = sampleRate
            info["channels"] = channels
        }
        return info
    }

    private func open(at t: Double, formatHint: CMFormatDescription?, size: (Int, Int) = (0, 0)) -> Bool {
        if failure != nil { return false }
        do {
            try? FileManager.default.removeItem(at: url)
            let fileType: AVFileType
            let settings: [String: Any]
            let mediaType: AVMediaType
            switch kind {
            case let .video(fps, quality):
                fileType = .mp4
                mediaType = .video
                let (width, height) = size
                videoSize = size
                let bitrate = videoBitrate(width: width, height: height, fps: fps, quality: quality)
                settings = [
                    AVVideoCodecKey: AVVideoCodecType.h264,
                    AVVideoWidthKey: width,
                    AVVideoHeightKey: height,
                    AVVideoCompressionPropertiesKey: [
                        AVVideoAverageBitRateKey: bitrate,
                        AVVideoExpectedSourceFrameRateKey: fps,
                        AVVideoMaxKeyFrameIntervalKey: fps * 2,
                        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                        AVVideoAllowFrameReorderingKey: false,
                    ] as [String: Any],
                ]
            case let .audio(sampleRate, channels, bitrate):
                // Opus in MP4, encoded by macOS itself: royalty-free, and decodable by the
                // Electron build without proprietary codecs (no AAC decoder there).
                fileType = .mp4
                mediaType = .audio
                settings = TrackWriter.opusSettings(sampleRate: sampleRate, channels: channels, bitrate: bitrate)
            }
            let w = try AVAssetWriter(outputURL: url, fileType: fileType)
            // Fragments are written every 2 s, so a file cut short by a crash stays readable.
            w.movieFragmentInterval = CMTime(seconds: 2, preferredTimescale: 600)
            var i = AVAssetWriterInput(mediaType: mediaType, outputSettings: settings, sourceFormatHint: formatHint)
            if case let .audio(sampleRate, channels, _) = kind, !w.canAdd(i) {
                // A macOS that cannot write Opus here gets 16-bit PCM (also royalty-free).
                Output.log("[\(source)] Opus yazılamıyor; PCM kullanılıyor")
                i = AVAssetWriterInput(mediaType: mediaType, outputSettings: TrackWriter.pcmSettings(sampleRate: sampleRate, channels: channels), sourceFormatHint: formatHint)
            }
            i.expectsMediaDataInRealTime = true
            guard w.canAdd(i) else { throw RecorderError("writer", "\(source): giriş eklenemedi") }
            w.add(i)
            if case .video = kind {
                adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: i, sourcePixelBufferAttributes: nil)
            }
            guard w.startWriting() else { throw w.error ?? RecorderError("writer", "\(source): yazma başlatılamadı") }
            w.startSession(atSourceTime: cmTime(t))
            writer = w
            input = i
            firstTime = t
            var line = describe()
            line["e"] = "track"
            line["startOffsetMs"] = t * 1000
            log?.write(line)
            return true
        } catch {
            failure = "\(error)"
            Output.log("[\(source)] writer: \(error)")
            return false
        }
    }

    static func opusSettings(sampleRate: Double, channels: Int, bitrate: Int) -> [String: Any] {
        [AVFormatIDKey: kAudioFormatOpus, AVSampleRateKey: sampleRate, AVNumberOfChannelsKey: channels, AVEncoderBitRateKey: bitrate]
    }

    static func pcmSettings(sampleRate: Double, channels: Int) -> [String: Any] {
        [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: sampleRate, AVNumberOfChannelsKey: channels,
         AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false]
    }

    private func cmTime(_ seconds: Double) -> CMTime {
        CMTime(seconds: seconds, preferredTimescale: 600_000)
    }

    /// Screen or camera frame at session time t (seconds).
    func appendVideo(_ pixelBuffer: CVPixelBuffer, at t: Double) {
        if writer == nil {
            let size = (CVPixelBufferGetWidth(pixelBuffer) & ~1, CVPixelBufferGetHeight(pixelBuffer) & ~1)
            if !open(at: t, formatHint: nil, size: size) { return }
        }
        guard t > lastTime, let input = input, let adaptor = adaptor else { return }
        guard input.isReadyForMoreMediaData else { dropped += 1; return }
        if adaptor.append(pixelBuffer, withPresentationTime: cmTime(t)) {
            appended += 1
            lastTime = t
        } else {
            dropped += 1
            if let e = writer?.error, failure == nil { failure = "\(e)"; Output.log("[\(source)] append: \(e)") }
        }
    }

    /// Audio buffer whose first sample plays at session time t (seconds).
    func appendAudio(_ sample: CMSampleBuffer, at t: Double) {
        if writer == nil, !open(at: t, formatHint: CMSampleBufferGetFormatDescription(sample)) { return }
        guard t > lastTime, let input = input else { return }
        guard input.isReadyForMoreMediaData else { dropped += 1; return }
        guard let retimed = retime(sample, to: t) else { dropped += 1; return }
        if input.append(retimed) {
            appended += 1
            lastTime = t
        } else {
            dropped += 1
            if let e = writer?.error, failure == nil { failure = "\(e)"; Output.log("[\(source)] append: \(e)") }
        }
    }

    private func retime(_ sample: CMSampleBuffer, to t: Double) -> CMSampleBuffer? {
        var count: CMItemCount = 0
        CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count)
        var timing = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: max(1, count))
        CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: timing.count, arrayToFill: &timing, entriesNeededOut: &count)
        let shift = CMTimeSubtract(cmTime(t), CMSampleBufferGetPresentationTimeStamp(sample))
        for k in 0..<timing.count {
            timing[k].presentationTimeStamp = CMTimeAdd(timing[k].presentationTimeStamp, shift)
            timing[k].decodeTimeStamp = .invalid
        }
        var out: CMSampleBuffer?
        let status = CMSampleBufferCreateCopyWithNewTiming(
            allocator: kCFAllocatorDefault, sampleBuffer: sample, sampleTimingEntryCount: timing.count,
            sampleTimingArray: &timing, sampleBufferOut: &out)
        return status == noErr ? out : nil
    }

    /// Closes the file so that it ends at session time `end`. Calls back on the writer's queue.
    func finish(end: Double, completion: @escaping ([String: Any]?) -> Void) {
        guard let w = writer, let input = input, let first = firstTime else {
            completion(nil)
            return
        }
        input.markAsFinished()
        w.endSession(atSourceTime: cmTime(max(end, lastTime)))
        w.finishWriting { [self] in
            guard w.status == .completed else {
                Output.log("[\(source)] finish: \(String(describing: w.error))")
                completion(["kind": source, "name": fileName, "mime": mime, "error": "\(String(describing: w.error))"])
                return
            }
            var info = describe()
            info["startOffsetMs"] = first * 1000
            info["durationMs"] = max(0, max(end, lastTime) - first) * 1000
            info["samples"] = appended
            info["dropped"] = dropped
            completion(info)
        }
    }
}

/// Bitrate for H.264 by pixel count and quality preset.
func videoBitrate(width: Int, height: Int, fps: Int, quality: String) -> Int {
    let bitsPerPixel: Double = quality == "max" ? 0.20 : quality == "high" ? 0.12 : 0.07
    let rate = Double(width * height) * Double(min(fps, 60)) * bitsPerPixel
    return Int(min(80_000_000, max(2_000_000, rate)))
}

/// Pixel size for capture: native resolution, limited so H.264 stays within its usual
/// limits (and the standard preset to 1080p), both sides even.
func capturePixelSize(points: CGSize, scale: CGFloat, quality: String) -> (width: Int, height: Int) {
    var w = Double(points.width * scale)
    var h = Double(points.height * scale)
    let maxW: Double = quality == "standard" ? 1920 : 3840
    let maxH: Double = quality == "standard" ? 1200 : 2400
    let k = min(1, maxW / max(1, w), maxH / max(1, h))
    w *= k
    h *= k
    let even = { (v: Double) -> Int in max(2, Int(v.rounded()) & ~1) }
    return (even(w), even(h))
}
