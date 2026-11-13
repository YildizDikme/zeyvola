// Writes synthetic files with flashes and 1 kHz tones at known times, to check that
// media-probe measures what it claims (and to learn its own bias, e.g. AAC priming).
//
//   make-fixture <dir>   → <dir>/fixture.mp4 (flash at 1.0 s and 3.0 s), <dir>/fixture.m4a (AAC tone at 1.0 s and 3.0 s),
//                          <dir>/fixture-av.mp4 (both in one file, H.264 + stereo AAC, like a phone video; for the
//                          import check of the smoke test: ZEYVOLA_SMOKE_AAC_FIXTURE=<dir>/fixture-av.mp4),
//                          <dir>/fixture-opus.m4a (the same tones written like the recorder's mic.m4a: Opus in fragmented
//                          MP4, session starting at 0.25 s source time, so the tones sit at 1.0 s and 3.0 s of the file)
import AVFoundation
import CoreMedia
import CoreVideo
import Foundation

let dir = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let marks: [Double] = [1.0, 3.0]
let total = 5.0

/// `sound`: also an AAC track with the tones (stereo, 48 kHz), written interleaved with the video.
func video(_ name: String = "fixture.mp4", sound: Bool = false) throws {
    let url = dir.appendingPathComponent(name)
    try? FileManager.default.removeItem(at: url)
    let w = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 640, AVVideoHeightKey: 400,
    ])
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: 640, kCVPixelBufferHeightKey as String: 400,
    ])
    w.add(input)
    let tones = sound ? ToneSource(writer: w, channels: 2, settings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 160_000,
    ]) : nil
    w.startWriting()
    w.startSession(atSourceTime: .zero)
    for f in 0..<Int(total * 60) {
        let t = Double(f) / 60
        tones?.append(until: t + 0.1)
        while !input.isReadyForMoreMediaData { usleep(1000) }
        var pb: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
        CVPixelBufferLockBaseAddress(pb!, [])
        let base = CVPixelBufferGetBaseAddress(pb!)!.assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRow(pb!)
        let on = marks.contains { t >= $0 - 1e-6 && t < $0 + 0.1 }
        for y in 0..<400 {
            for x in 0..<640 {
                let inSquare = x >= 560 && x < 624 && y >= 16 && y < 72
                let v: UInt8 = inSquare && on ? 255 : 16
                let p = y * stride + x * 4
                base[p] = v; base[p + 1] = v; base[p + 2] = v; base[p + 3] = 255
            }
        }
        CVPixelBufferUnlockBaseAddress(pb!, [])
        adaptor.append(pb!, withPresentationTime: CMTime(value: CMTimeValue(f), timescale: 60))
    }
    input.markAsFinished()
    tones?.append(until: total)
    tones?.input.markAsFinished()
    let s = DispatchSemaphore(value: 0)
    w.finishWriting { s.signal() }
    s.wait()
    if w.status != .completed { throw w.error ?? NSError(domain: "make-fixture", code: 2) }
}

/// 1 kHz tones at `marks` (0.1 s each, otherwise silence) appended in 1024-frame chunks.
final class ToneSource {
    let input: AVAssetWriterInput
    let channels: Int
    let rate = 48_000.0
    var n = 0
    var format: CMAudioFormatDescription?

    init(writer: AVAssetWriter, channels: Int, settings: [String: Any]) {
        self.channels = channels
        input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
        writer.add(input)
        var asbd = AudioStreamBasicDescription(mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked, mBytesPerPacket: UInt32(4 * channels), mFramesPerPacket: 1,
            mBytesPerFrame: UInt32(4 * channels), mChannelsPerFrame: UInt32(channels), mBitsPerChannel: 32, mReserved: 0)
        CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format)
    }

    /// Appends chunks until the source time reaches `t` (or the end of the file).
    func append(until t: Double) {
        let chunk = 1024
        while Double(n) / rate < min(t, total) {
            var samples = [Float](repeating: 0, count: chunk * channels)
            for i in 0..<chunk {
                let s = Double(n + i) / rate
                let v: Float = marks.contains(where: { s >= $0 && s < $0 + 0.1 }) ? Float(0.5 * sin(2 * .pi * 1000 * s)) : 0
                for c in 0..<channels { samples[i * channels + c] = v }
            }
            let bytes = chunk * channels * 4
            var block: CMBlockBuffer?
            CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil,
                customBlockSource: nil, offsetToData: 0, dataLength: bytes, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
            samples.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block!, offsetIntoDestination: 0, dataLength: bytes) }
            var sample: CMSampleBuffer?
            CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block!, formatDescription: format!,
                sampleCount: chunk, presentationTimeStamp: CMTime(value: CMTimeValue(n), timescale: CMTimeScale(rate)),
                packetDescriptions: nil, sampleBufferOut: &sample)
            while !input.isReadyForMoreMediaData { usleep(1000) }
            input.append(sample!)
            n += chunk
        }
    }
}

/// `start`: source time of the first sample (the recorder starts each file at its first sample's session time).
func audio(_ name: String, fileType: AVFileType, settings: [String: Any], fragmented: Bool = false, start: Double = 0) throws {
    let url = dir.appendingPathComponent(name)
    try? FileManager.default.removeItem(at: url)
    let rate = 48_000.0
    let w = try AVAssetWriter(outputURL: url, fileType: fileType)
    if fragmented { w.movieFragmentInterval = CMTime(seconds: 2, preferredTimescale: 600) }
    let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
    input.expectsMediaDataInRealTime = fragmented
    guard w.canAdd(input) else { throw NSError(domain: "make-fixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(name): cannot add input"]) }
    w.add(input)
    w.startWriting()
    w.startSession(atSourceTime: CMTime(seconds: start, preferredTimescale: 48_000))
    var asbd = AudioStreamBasicDescription(mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked, mBytesPerPacket: 4, mFramesPerPacket: 1,
        mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
    var format: CMAudioFormatDescription?
    CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format)
    let chunk = 1024
    var n = 0
    while Double(n) / rate < total {
        var samples = [Float](repeating: 0, count: chunk)
        for i in 0..<chunk {
            let t = Double(n + i) / rate
            if marks.contains(where: { t >= $0 && t < $0 + 0.1 }) { samples[i] = Float(0.5 * sin(2 * .pi * 1000 * t)) }
        }
        var block: CMBlockBuffer?
        CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: chunk * 4, blockAllocator: nil,
            customBlockSource: nil, offsetToData: 0, dataLength: chunk * 4, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
        samples.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block!, offsetIntoDestination: 0, dataLength: chunk * 4) }
        var sample: CMSampleBuffer?
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block!, formatDescription: format!,
            sampleCount: chunk, presentationTimeStamp: CMTimeAdd(CMTime(seconds: start, preferredTimescale: 48_000), CMTime(value: CMTimeValue(n), timescale: CMTimeScale(rate))),
            packetDescriptions: nil, sampleBufferOut: &sample)
        while !input.isReadyForMoreMediaData { usleep(1000) }
        input.append(sample!)
        n += chunk
    }
    input.markAsFinished()
    let s = DispatchSemaphore(value: 0)
    w.finishWriting { s.signal() }
    s.wait()
}

try video()
try video("fixture-av.mp4", sound: true)
try audio("fixture.m4a", fileType: .m4a, settings: [
    AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 128_000,
])
// Same settings as TrackWriter.opusSettings (native/recorder-macos) for the microphone.
try audio("fixture-opus.m4a", fileType: .mp4, settings: [
    AVFormatIDKey: kAudioFormatOpus, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 128_000,
], fragmented: true, start: 0.25)
print("ok")
