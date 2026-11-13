// Measures a recorded file for the real capture tests (AVFoundation only).
//
//   media-probe <file> [--regions x,y,w,h;x,y,w,h…]
//
// Video: frame count, timing (intervals, gaps) and, per region (fractions of the frame),
// the times its brightness jumps up (a flash). Audio: length, rate and the start times of
// the 1 kHz test tone. All times are seconds from the file's first sample.
import AVFoundation
import CoreMedia
import CoreVideo
import Foundation

func emit(_ object: Any) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fail(_ message: String) -> Never {
    emit(["error": message])
    exit(1)
}

struct Region { let x, y, w, h: Double }

/// Rising edges of a signal: crossing the midpoint between its quiet and bright levels,
/// at least `gap` seconds apart. Empty if the signal barely changes.
func rises(_ series: [(Double, Double)], minSwing: Double, gap: Double) -> [Double] {
    guard let lo = series.map(\.1).min(), let hi = series.map(\.1).max(), hi - lo >= minSwing else { return [] }
    let mid = (lo + hi) / 2
    var out: [Double] = []
    var prev = series.first!.1
    for (t, v) in series.dropFirst() {
        if prev < mid, v >= mid, (out.last.map { t - $0 >= gap } ?? true) { out.append(t) }
        prev = v
    }
    return out
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: media-probe <file> [--regions x,y,w,h;…]") }
let url = URL(fileURLWithPath: args[1])
var regions: [Region] = []
if let i = args.firstIndex(of: "--regions"), i + 1 < args.count {
    regions = args[i + 1].split(separator: ";").compactMap { part in
        let v = part.split(separator: ",").compactMap { Double($0) }
        return v.count == 4 ? Region(x: v[0], y: v[1], w: v[2], h: v[3]) : nil
    }
}

let asset = AVURLAsset(url: url)
let semaphore = DispatchSemaphore(value: 0)
var tracks: [AVAssetTrack] = []
var assetDuration = 0.0
Task {
    do {
        tracks = try await asset.load(.tracks)
        assetDuration = try await asset.load(.duration).seconds
    } catch {
        fail("load: \(error.localizedDescription)")
    }
    semaphore.signal()
}
semaphore.wait()
guard let track = tracks.first else { fail("no tracks") }

let reader: AVAssetReader
do { reader = try AVAssetReader(asset: asset) } catch { fail("reader: \(error.localizedDescription)") }

if track.mediaType == .video {
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
    ])
    output.alwaysCopiesSampleData = false
    reader.add(output)
    guard reader.startReading() else { fail("startReading: \(String(describing: reader.error))") }
    var times: [Double] = []
    var series = Array(repeating: [(Double, Double)](), count: regions.count)
    var width = 0, height = 0
    while let sample = output.copyNextSampleBuffer() {
        let t = CMSampleBufferGetPresentationTimeStamp(sample).seconds
        guard let pb = CMSampleBufferGetImageBuffer(sample) else { continue }
        times.append(t)
        if regions.isEmpty { continue }
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        width = CVPixelBufferGetWidthOfPlane(pb, 0)
        height = CVPixelBufferGetHeightOfPlane(pb, 0)
        let stride = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
        let base = CVPixelBufferGetBaseAddressOfPlane(pb, 0)!.assumingMemoryBound(to: UInt8.self)
        for (k, r) in regions.enumerated() {
            let x0 = max(0, Int(r.x * Double(width))), x1 = min(width, Int((r.x + r.w) * Double(width)))
            let y0 = max(0, Int(r.y * Double(height))), y1 = min(height, Int((r.y + r.h) * Double(height)))
            var sum = 0, n = 0
            var y = y0
            while y < y1 {
                var x = x0
                while x < x1 { sum += Int(base[y * stride + x]); n += 1; x += 4 }
                y += 4
            }
            series[k].append((t, n > 0 ? Double(sum) / Double(n) : 0))
        }
        CVPixelBufferUnlockBaseAddress(pb, .readOnly)
    }
    if reader.status == .failed { fail("read: \(String(describing: reader.error))") }
    guard let first = times.first else { fail("no frames") }
    let rel = times.map { $0 - first }
    let intervals = zip(rel.dropFirst(), rel).map { $0 - $1 }.sorted()
    let median = intervals.isEmpty ? 0 : intervals[intervals.count / 2]
    let mean = intervals.isEmpty ? 0 : intervals.reduce(0, +) / Double(intervals.count)
    let gaps = intervals.filter { $0 > median * 1.5 + 0.002 }
    let size = (try? awaitSize(track)) ?? .zero
    var regionReports: [[String: Any]] = []
    for (k, r) in regions.enumerated() {
        let shifted = series[k].map { ($0.0 - first, $0.1) }
        let values = shifted.map(\.1)
        let mean = values.isEmpty ? 0 : values.reduce(0, +) / Double(values.count)
        regionReports.append(["rect": [r.x, r.y, r.w, r.h], "rises": rises(shifted, minSwing: 60, gap: 0.3),
                              "lumaMean": mean, "lumaMin": values.min() ?? 0, "lumaMax": values.max() ?? 0])
    }
    let maxInterval: Double = intervals.last ?? 0
    let p99 = intervals.isEmpty ? 0 : intervals[min(intervals.count - 1, Int(Double(intervals.count) * 0.99))]
    let report: [String: Any] = [
        "kind": "video", "file": url.lastPathComponent, "assetDuration": assetDuration,
        "frames": times.count, "firstPts": first, "lastPts": times.last!, "span": rel.last!,
        "medianInterval": median, "meanInterval": mean, "maxInterval": maxInterval,
        "p99Interval": p99, "gaps": gaps.count, "width": Int(size.width), "height": Int(size.height),
        "regions": regionReports,
    ]
    emit(report)
} else if track.mediaType == .audio {
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true,
        AVLinearPCMIsNonInterleaved: false, AVLinearPCMIsBigEndianKey: false,
    ])
    reader.add(output)
    guard reader.startReading() else { fail("startReading: \(String(describing: reader.error))") }
    var rate = 48_000.0
    var channels = 1
    var firstPts: Double?
    var mono: [Float] = []
    while let sample = output.copyNextSampleBuffer() {
        if firstPts == nil {
            firstPts = CMSampleBufferGetPresentationTimeStamp(sample).seconds
            if let f = CMSampleBufferGetFormatDescription(sample), let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(f)?.pointee {
                rate = asbd.mSampleRate
                channels = Int(asbd.mChannelsPerFrame)
            }
        }
        guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
        var length = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == noErr,
              let p = pointer else { continue }
        let floats = UnsafeRawPointer(p).assumingMemoryBound(to: Float.self)
        let count = length / 4 / channels
        for i in 0..<count {
            var s: Float = 0
            for c in 0..<channels { s += floats[i * channels + c] }
            mono.append(s / Float(channels))
        }
    }
    if reader.status == .failed { fail("read: \(String(describing: reader.error))") }
    // 1 kHz tone energy (Goertzel) in 5 ms windows, against the window's total energy.
    let window = Int(rate * 0.005)
    let coeff = 2 * cos(2 * Double.pi * 1000 / rate)
    var series: [(Double, Double)] = []
    var purity: [Double] = []
    var peak = 0.0
    var i = 0
    while i + window <= mono.count {
        var s1 = 0.0, s2 = 0.0, energy = 0.0
        for k in i..<(i + window) {
            let x = Double(mono[k])
            energy += x * x
            let s0 = x + coeff * s1 - s2
            s2 = s1
            s1 = s0
        }
        let power = (s1 * s1 + s2 * s2 - coeff * s1 * s2) / Double(window * window)
        series.append((Double(i) / rate, power))
        purity.append(energy > 0 ? 2 * power / (energy / Double(window)) : 0)
        peak = max(peak, sqrt(energy / Double(window)))
        i += window
    }
    let maxPower = series.map(\.1).max() ?? 0
    // Onsets: the 1 kHz part is audible (amplitude ≥ 0.003, about −50 dBFS) and dominates
    // the window (purity ≥ 0.5; a pure tone gives 1), and power rises past 10% of its
    // maximum. Noise and speech do not pass the purity test.
    var onsets: [Double] = []
    var prevOn = false
    for (k, (t, v)) in series.enumerated() {
        let amplitude = 2 * sqrt(v)
        let on = amplitude >= 0.003 && purity[k] >= 0.5 && v >= maxPower * 0.1
        if on, !prevOn, (onsets.last.map { t - $0 >= 0.5 } ?? true) { onsets.append(t) }
        prevOn = on
    }
    let audioReport: [String: Any] = [
        "kind": "audio", "file": url.lastPathComponent, "assetDuration": assetDuration, "sampleRate": rate,
        "channels": channels, "firstPts": firstPts ?? 0, "span": Double(mono.count) / rate,
        "peak": peak, "tonePower": maxPower, "toneOnsets": onsets,
    ]
    emit(audioReport)
} else {
    fail("unsupported track \(track.mediaType.rawValue)")
}

func awaitSize(_ track: AVAssetTrack) throws -> CGSize {
    let s = DispatchSemaphore(value: 0)
    var size = CGSize.zero
    Task {
        size = (try? await track.load(.naturalSize)) ?? .zero
        s.signal()
    }
    s.wait()
    return size
}
