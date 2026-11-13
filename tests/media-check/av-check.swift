// Checks an exported video with macOS's own media stack (AVFoundation), the way QuickTime and
// other system players see it — not with Chromium's decoders, which the app's other tests use.
//
//   av-check <file> [--require h264-aac] [--duration <seconds>]
//
// Prints one JSON line: what AVFoundation found (tracks, codecs, playable, decoded frames and
// sound) and, with --require, the problems that make the file unfit ("problems": [], "ok": true
// when there are none). Exit code 0 when ok, 1 when not, 2 on bad arguments.
import AVFoundation
import CoreMedia
import CoreVideo
import Foundation

func emit(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fourCC(_ code: FourCharCode) -> String {
    let bytes = [24, 16, 8, 0].map { UInt8((code >> $0) & 0xff) }
    return String(bytes: bytes, encoding: .ascii) ?? String(code)
}

func codecOf(_ track: AVAssetTrack) -> String? {
    guard let first = track.formatDescriptions.first else { return nil }
    return fourCC(CMFormatDescriptionGetMediaSubType(first as! CMFormatDescription))
}

/// Brightness spread of a frame: 5th to 95th percentile of sampled luma, 0…1. A blank frame is ~0.
func spread(_ pb: CVPixelBuffer) -> Double {
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pb) else { return 0 }
    let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb), row = CVPixelBufferGetBytesPerRow(pb)
    let p = base.assumingMemoryBound(to: UInt8.self)
    var lumas: [Double] = []
    let step = max(1, min(w, h) / 48)
    for y in stride(from: 0, to: h, by: step) {
        for x in stride(from: 0, to: w, by: step) {
            let o = y * row + x * 4 // BGRA
            lumas.append(0.0722 * Double(p[o]) + 0.7152 * Double(p[o + 1]) + 0.2126 * Double(p[o + 2]))
        }
    }
    guard !lumas.isEmpty else { return 0 }
    lumas.sort()
    return (lumas[Int(Double(lumas.count - 1) * 0.95)] - lumas[Int(Double(lumas.count - 1) * 0.05)]) / 255
}

func decodeVideo(_ asset: AVAsset, _ track: AVAssetTrack) -> [String: Any] {
    do {
        let reader = try AVAssetReader(asset: asset)
        let out = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        out.alwaysCopiesSampleData = false
        guard reader.canAdd(out) else { return ["decodedFrames": 0, "error": "track output not accepted"] }
        reader.add(out)
        guard reader.startReading() else { return ["decodedFrames": 0, "error": reader.error?.localizedDescription ?? "startReading failed"] }
        var frames = 0
        var best = 0.0
        while let sb = out.copyNextSampleBuffer() {
            guard let pb = CMSampleBufferGetImageBuffer(sb) else { continue }
            if frames % 10 == 0 { best = max(best, spread(pb)) }
            frames += 1
        }
        var r: [String: Any] = ["decodedFrames": frames, "spread": best]
        if reader.status == .failed { r["error"] = reader.error?.localizedDescription ?? "decoding failed" }
        return r
    } catch {
        return ["decodedFrames": 0, "error": error.localizedDescription]
    }
}

func decodeAudio(_ asset: AVAsset, _ track: AVAssetTrack) -> [String: Any] {
    do {
        let reader = try AVAssetReader(asset: asset)
        let out = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false, AVLinearPCMIsBigEndianKey: false,
        ])
        guard reader.canAdd(out) else { return ["decodedSeconds": 0, "error": "track output not accepted"] }
        reader.add(out)
        guard reader.startReading() else { return ["decodedSeconds": 0, "error": reader.error?.localizedDescription ?? "startReading failed"] }
        var frames = 0
        var rate = 0.0
        var peak: Float = 0
        while let sb = out.copyNextSampleBuffer() {
            if rate == 0, let fd = CMSampleBufferGetFormatDescription(sb), let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee {
                rate = asbd.mSampleRate
            }
            frames += CMSampleBufferGetNumSamples(sb)
            guard let block = CMSampleBufferGetDataBuffer(sb) else { continue }
            var length = 0
            var ptr: UnsafeMutablePointer<CChar>?
            if CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &ptr) == kCMBlockBufferNoErr, let ptr {
                ptr.withMemoryRebound(to: Float.self, capacity: length / 4) { f in
                    for i in 0..<(length / 4) { peak = max(peak, abs(f[i])) }
                }
            }
        }
        var r: [String: Any] = ["decodedSeconds": rate > 0 ? Double(frames) / rate : 0, "peak": Double(peak)]
        if reader.status == .failed { r["error"] = reader.error?.localizedDescription ?? "decoding failed" }
        return r
    } catch {
        return ["decodedSeconds": 0, "error": error.localizedDescription]
    }
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    emit(["error": "usage: av-check <file> [--require h264-aac] [--duration <seconds>]"])
    exit(2)
}
func value(_ flag: String) -> String? { args.firstIndex(of: flag).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }
let path = args[1]
let require = value("--require")
let expected = value("--duration").flatMap(Double.init)
guard FileManager.default.fileExists(atPath: path) else {
    emit(["error": "no such file", "ok": false, "problems": ["dosya yok"]])
    exit(1)
}

let asset = AVURLAsset(url: URL(fileURLWithPath: path))
let duration = CMTimeGetSeconds(asset.duration)
var report: [String: Any] = ["file": path, "duration": duration.isFinite ? duration : 0, "playable": asset.isPlayable]
var problems: [String] = []

let videoTracks = asset.tracks(withMediaType: .video)
if let vt = videoTracks.first {
    var v: [String: Any] = ["codec": codecOf(vt) ?? "?", "playable": vt.isPlayable, "width": Double(vt.naturalSize.width), "height": Double(vt.naturalSize.height)]
    for (k, val) in decodeVideo(asset, vt) { v[k] = val }
    report["video"] = v
} else {
    report["video"] = NSNull()
}
let audioTracks = asset.tracks(withMediaType: .audio)
if let at = audioTracks.first {
    var a: [String: Any] = ["codec": codecOf(at) ?? "?", "playable": at.isPlayable]
    for (k, val) in decodeAudio(asset, at) { a[k] = val }
    report["audio"] = a
} else {
    report["audio"] = NSNull()
}

if require == "h264-aac" {
    if let v = report["video"] as? [String: Any] {
        let codec = v["codec"] as? String ?? "?"
        if codec != "avc1" { problems.append("görüntü H.264 değil (\(codec))") }
        let frames = v["decodedFrames"] as? Int ?? 0
        if frames == 0 || (v["playable"] as? Bool) != true {
            problems.append("görüntü çözülemiyor\((v["error"] as? String).map { ": \($0)" } ?? "")")
        } else if (v["spread"] as? Double ?? 0) < 0.02 {
            problems.append("çözülen kareler boş (tek renk)")
        }
    } else {
        problems.append("görüntü izi yok")
    }
    if let a = report["audio"] as? [String: Any] {
        let codec = a["codec"] as? String ?? "?"
        if codec != "aac " { problems.append("ses AAC değil (\(codec.trimmingCharacters(in: .whitespaces)))") }
        if (a["decodedSeconds"] as? Double ?? 0) <= 0 { problems.append("ses çözülemiyor\((a["error"] as? String).map { ": \($0)" } ?? "")") }
        else if (a["peak"] as? Double ?? 0) < 0.001 { problems.append("ses sessiz") }
    } else {
        problems.append("ses izi yok")
    }
    if (report["playable"] as? Bool) != true { problems.append("AVFoundation dosyayı oynatılabilir saymıyor") }
}
if let expected, abs(duration - expected) > 0.15 {
    problems.append(String(format: "süre %.3f sn, beklenen %.3f sn", duration, expected))
}
report["problems"] = problems
report["ok"] = problems.isEmpty
emit(report)
exit(problems.isEmpty ? 0 : 1)
