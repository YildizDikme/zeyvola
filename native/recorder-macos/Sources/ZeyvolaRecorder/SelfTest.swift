import AVFoundation
import CoreGraphics
import CoreVideo
import Foundation

/// Checks of the helper's pure logic (no capture, no permissions): `zeyvola-recorder --self-test`.
enum SelfTest {
    static func run() -> Bool {
        var failures: [String] = []
        func check(_ ok: Bool, _ name: String) { if !ok { failures.append(name) } }
        func near(_ a: Double?, _ b: Double, _ eps: Double = 1e-9) -> Bool { a.map { abs($0 - b) < eps } ?? false }

        // Session clock: pauses are cut out, samples inside a pause or before start are dropped.
        let c = SessionClock()
        check(c.sessionSeconds(host: 100) == nil, "clock: before start")
        c.start(at: 100)
        check(near(c.sessionSeconds(host: 101.5), 1.5), "clock: running")
        c.pause(at: 102)
        check(c.sessionSeconds(host: 102.5) == nil, "clock: during pause")
        c.resume(at: 105)
        check(c.sessionSeconds(host: 103) == nil, "clock: late sample from the pause")
        check(near(c.sessionSeconds(host: 106), 3), "clock: after resume")
        check(near(c.elapsed(at: 107), 4), "clock: elapsed")
        c.stop(at: 108)
        check(c.sessionSeconds(host: 108.5) == nil, "clock: after stop")
        check(near(c.elapsed(at: 200), 5), "clock: elapsed clamps at stop")
        check(SessionClock.ticks(1) == 705_600_000, "ticks: 1 s")
        check(SessionClock.ticks(1.0 / 60) == 11_760_000, "ticks: 1/60 s")

        // Capture size: native resolution within limits, even sides, aspect kept.
        let s1 = capturePixelSize(points: CGSize(width: 1512, height: 982), scale: 2, quality: "high")
        check(s1.width == 3024 && s1.height == 1964, "size: retina 14\" kept native")
        check(s1.width % 2 == 0 && s1.height % 2 == 0, "size: even")
        let s2 = capturePixelSize(points: CGSize(width: 2560, height: 1440), scale: 2, quality: "high")
        check(s2.width <= 3840 && s2.height <= 2400, "size: 5K capped")
        check(abs(Double(s2.width) / Double(s2.height) - 16.0 / 9.0) < 0.01, "size: aspect kept")
        let s3 = capturePixelSize(points: CGSize(width: 1920, height: 1080), scale: 1, quality: "standard")
        check(s3.width == 1920 && s3.height == 1080, "size: 1080p standard unchanged")

        // Bitrate stays in sane bounds.
        let b1 = videoBitrate(width: 1920, height: 1080, fps: 30, quality: "standard")
        check(b1 >= 2_000_000 && b1 <= 10_000_000, "bitrate: 1080p30 standard")
        check(videoBitrate(width: 3840, height: 2160, fps: 60, quality: "max") <= 80_000_000, "bitrate: capped")

        // Device names from the app match AVFoundation names.
        let items = [(1, "FaceTime HD Camera"), (2, "External USB Camera")]
        check(matchName(items, label: "FaceTime HD Camera") == 1, "match: exact")
        check(matchName(items, label: "External USB Camera (046d:085e)") == 2, "match: browser suffix")
        check(matchName(items, label: "Bilinmeyen") == nil, "match: none")

        // Session log and file probe, in a temporary folder of their own (no capture).
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("zeyvola-selftest-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: dir) }

            let log = SessionLog(directory: dir)
            log.write(["e": "mark", "t": 1]) // before begin: ignored
            try log.begin(["e": "session", "v": 1])
            log.write(["e": "track", "kind": "screen", "name": "screen.mp4", "startOffsetMs": 12.5])
            log.write(["e": "mark", "t": SessionClock.ticks(1)])
            log.close()
            log.write(["e": "end"]) // after close: ignored
            let text = (try? String(contentsOf: dir.appendingPathComponent(SessionLog.fileName), encoding: .utf8)) ?? ""
            let lines = text.split(separator: "\n").compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
            check(lines.map { $0["e"] as? String ?? "" } == ["session", "track", "mark"], "session log: lines in order")
            check(text.hasSuffix("\n"), "session log: whole lines")
            check((lines.dropFirst().first?["startOffsetMs"] as? Double) == 12.5, "session log: values kept")

            let video = dir.appendingPathComponent("probe.mp4")
            if writeTestVideo(video, frames: 30, fps: 30) {
                let p = FileProbe.probe(video)
                check(p["error"] == nil, "probe: readable")
                check((p["samples"] as? Int) == 30, "probe: every frame")
                check(abs(((p["durationMs"] as? Double) ?? 0) - 1000) < 40, "probe: length of 30 frames at 30 fps")
                check((p["width"] as? Int) == 64 && (p["kind"] as? String) == "video", "probe: format")
            } else {
                check(false, "probe: test video written")
            }
            // Microphone track through the real writer: Opus in MP4, from 44.1 kHz input.
            let mic = TrackWriter(source: "mic", fileName: "mic.m4a", mime: "audio/mp4", directory: dir,
                                  kind: .audio(sampleRate: 48_000, channels: 1, bitrate: 128_000), queue: DispatchQueue(label: "selftest.mic"))
            if feedTestAudio(mic, seconds: 2, rate: 44_100) {
                let url = dir.appendingPathComponent("mic.m4a")
                let p = FileProbe.probe(url)
                check(p["error"] == nil && (p["kind"] as? String) == "audio", "audio: readable")
                check(abs(((p["durationMs"] as? Double) ?? 0) - 2000) < 60, "audio: length of 2 s")
                check((p["sampleRate"] as? Double) == 48_000 || (p["sampleRate"] as? Int) == 48_000, "audio: 48 kHz")
                check(audioFormat(url) == kAudioFormatOpus, "audio: Opus (royalty-free, no AAC)")
            } else {
                check(false, "audio: test track written")
            }
            // A video's AAC sound (written here by macOS's AAC encoder) comes out as Opus.
            let aac = dir.appendingPathComponent("aac.m4a")
            if writeTestAAC(aac, seconds: 1.5) {
                let r = AudioExtract.extract(input: aac, output: dir.appendingPathComponent("aac-sound.m4a"))
                check(r["error"] == nil && (r["converted"] as? Bool) == true && (r["from"] as? String) == "aac", "extract: AAC is converted")
                check(audioFormat(dir.appendingPathComponent("aac-sound.m4a")) == kAudioFormatOpus, "extract: result is Opus")
                check(abs(((r["durationMs"] as? Double) ?? 0) - 1500) < 60, "extract: length kept")
                let again = AudioExtract.extract(input: dir.appendingPathComponent("aac-sound.m4a"), output: dir.appendingPathComponent("x.m4a"))
                check((again["converted"] as? Bool) == false, "extract: Opus is left alone")
                check((AudioExtract.extract(input: video, output: dir.appendingPathComponent("y.m4a"))["audio"] as? Bool) == false, "extract: silent video has no sound")
            } else {
                check(false, "extract: AAC test file written")
            }
            let broken = dir.appendingPathComponent("broken.mp4")
            try Data("not a movie".utf8).write(to: broken)
            check(FileProbe.probe(broken)["error"] != nil, "probe: unreadable file reported")
        } catch {
            check(false, "temp folder: \(error)")
        }

        let result: [String: Any] = ["selfTest": failures.isEmpty ? "ok" : "failed", "failures": failures]
        Output.send(result)
        return failures.isEmpty
    }

    /// Feeds `seconds` of a 1 kHz tone (mono float PCM at `rate`) through a TrackWriter and closes it.
    private static func feedTestAudio(_ w: TrackWriter, seconds: Double, rate: Double) -> Bool {
        var asbd = AudioStreamBasicDescription(mSampleRate: rate, mFormatID: kAudioFormatLinearPCM, mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
                                               mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
        var format: CMAudioFormatDescription?
        guard CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format) == noErr, let fmt = format else { return false }
        let n = 1024
        let total = Int(seconds * rate)
        var ok = true
        w.queue.sync {
            var done = 0
            while done < total, ok {
                let count = min(n, total - done)
                var pcm = [Float](repeating: 0, count: count)
                for k in 0..<count { pcm[k] = Float(sin(2 * Double.pi * 1000 * Double(done + k) / rate) * 0.3) }
                var block: CMBlockBuffer?
                guard CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: count * 4, blockAllocator: nil, customBlockSource: nil,
                                                         offsetToData: 0, dataLength: count * 4, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block) == noErr, let b = block else { ok = false; break }
                _ = pcm.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: b, offsetIntoDestination: 0, dataLength: count * 4) }
                var sample: CMSampleBuffer?
                guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: b, formatDescription: fmt, sampleCount: count,
                                                                          presentationTimeStamp: CMTime(value: CMTimeValue(done), timescale: CMTimeScale(rate)),
                                                                          packetDescriptions: nil, sampleBufferOut: &sample) == noErr, let s = sample else { ok = false; break }
                // Offline: wait for the encoder instead of dropping like a live source would.
                var waited = 0
                while w.appended == 0 && done > 0 && waited < 200 { Thread.sleep(forTimeInterval: 0.005); waited += 1 }
                w.appendAudio(s, at: 0.001 + Double(done) / rate)
                done += count
                Thread.sleep(forTimeInterval: 0.001)
            }
        }
        let finished = DispatchSemaphore(value: 0)
        var info: [String: Any]?
        w.queue.async { w.finish(end: 0.001 + seconds) { info = $0; finished.signal() } }
        finished.wait()
        return ok && info != nil && info?["error"] == nil && w.dropped == 0
    }

    /// A short AAC file from macOS's own encoder (stands in for a video's sound).
    private static func writeTestAAC(_ url: URL, seconds: Double) -> Bool {
        guard let w = try? AVAssetWriter(outputURL: url, fileType: .m4a) else { return false }
        let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 128_000])
        guard w.canAdd(input) else { return false }
        w.add(input)
        guard w.startWriting() else { return false }
        w.startSession(atSourceTime: .zero)
        var asbd = AudioStreamBasicDescription(mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM, mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
                                               mBytesPerPacket: 8, mFramesPerPacket: 1, mBytesPerFrame: 8, mChannelsPerFrame: 2, mBitsPerChannel: 32, mReserved: 0)
        var format: CMAudioFormatDescription?
        guard CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format) == noErr, let fmt = format else { return false }
        let total = Int(seconds * 48_000)
        var done = 0
        while done < total {
            let n = min(4800, total - done)
            var pcm = [Float](repeating: 0, count: n * 2)
            for k in 0..<n { let v = Float(sin(2 * Double.pi * 440 * Double(done + k) / 48_000) * 0.3); pcm[2 * k] = v; pcm[2 * k + 1] = v }
            var block: CMBlockBuffer?
            guard CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: n * 8, blockAllocator: nil, customBlockSource: nil,
                                                     offsetToData: 0, dataLength: n * 8, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block) == noErr, let b = block else { return false }
            _ = pcm.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: b, offsetIntoDestination: 0, dataLength: n * 8) }
            var sample: CMSampleBuffer?
            guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: b, formatDescription: fmt, sampleCount: n,
                                                                      presentationTimeStamp: CMTime(value: CMTimeValue(done), timescale: 48_000),
                                                                      packetDescriptions: nil, sampleBufferOut: &sample) == noErr, let s = sample else { return false }
            while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
            guard input.append(s) else { return false }
            done += n
        }
        input.markAsFinished()
        let finished = DispatchSemaphore(value: 0)
        w.finishWriting { finished.signal() }
        finished.wait()
        return w.status == .completed
    }

    private static func audioFormat(_ url: URL) -> AudioFormatID? {
        let asset = AVURLAsset(url: url)
        let done = DispatchSemaphore(value: 0)
        var id: AudioFormatID?
        Task {
            if let track = try? await asset.loadTracks(withMediaType: .audio).first,
               let desc = try? await track.load(.formatDescriptions).first {
                id = CMFormatDescriptionGetMediaSubType(desc)
            }
            done.signal()
        }
        done.wait()
        return id
    }

    /// A small synthetic H.264 file (grey frames, fragmented like a recording), for the probe.
    private static func writeTestVideo(_ url: URL, frames: Int, fps: Int) -> Bool {
        guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { return false }
        writer.movieFragmentInterval = CMTime(seconds: 0.5, preferredTimescale: 600)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 64, AVVideoHeightKey: 64,
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: 64, kCVPixelBufferHeightKey as String: 64,
        ])
        guard writer.canAdd(input) else { return false }
        writer.add(input)
        guard writer.startWriting() else { return false }
        writer.startSession(atSourceTime: .zero)
        for n in 0..<frames {
            while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.005) }
            var buffer: CVPixelBuffer?
            guard let pool = adaptor.pixelBufferPool, CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess, let b = buffer else { return false }
            CVPixelBufferLockBaseAddress(b, [])
            if let base = CVPixelBufferGetBaseAddress(b) { memset(base, Int32(n * 8 % 256), CVPixelBufferGetDataSize(b)) }
            CVPixelBufferUnlockBaseAddress(b, [])
            guard adaptor.append(b, withPresentationTime: CMTime(value: CMTimeValue(n), timescale: CMTimeScale(fps))) else { return false }
        }
        input.markAsFinished()
        writer.endSession(atSourceTime: CMTime(value: CMTimeValue(frames), timescale: CMTimeScale(fps)))
        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        done.wait()
        return writer.status == .completed
    }
}
