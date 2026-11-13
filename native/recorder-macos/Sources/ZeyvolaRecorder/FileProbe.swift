import AVFoundation
import CoreMedia
import Foundation

/// `zeyvola-recorder --probe-files <dir>`: what is actually playable in each recorded file of a
/// folder, for rebuilding a recording after a crash. Nothing is captured and no permission is
/// needed. Prints one line:
///
///   {"type":"probe","dir":…,"files":[{"name":"screen.mp4","kind":"video","durationMs":…,"firstMs":…,
///     "samples":…,"assetDurationMs":…,"width":…,"height":…}, {"name":…,"error":…}]}
///
/// The length comes from reading the track's samples in their storage format (no decoding):
/// a file cut short by a crash ends at its last complete fragment, and only samples that can
/// be read count. `firstMs` is the first sample's time on the file's own timeline (0 for the
/// helper's files; the offset on the recording clock is in session.jsonl), `assetDurationMs`
/// what the container itself claims.
enum FileProbe {
    static let extensions: Set<String> = ["mp4", "m4a", "mov", "m4v"]

    static func run(directory: String) -> Bool {
        let dir = URL(fileURLWithPath: directory, isDirectory: true)
        let names: [String]
        do {
            names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        } catch {
            Output.send(["type": "probe", "dir": dir.path, "error": error.localizedDescription])
            return false
        }
        let media = names.filter { extensions.contains(($0 as NSString).pathExtension.lowercased()) }.sorted()
        Output.send(["type": "probe", "dir": dir.path, "files": media.map { probe(dir.appendingPathComponent($0)) }])
        return true
    }

    private final class Box<T>: @unchecked Sendable {
        var result: Result<T, Error> = .failure(RecorderError("probe", "not loaded"))
    }

    /// Loads an asset property synchronously (the probe runs before the app's run loop).
    private static func load<T>(_ work: @escaping @Sendable () async throws -> T) -> Result<T, Error> {
        let semaphore = DispatchSemaphore(value: 0)
        let box = Box<T>()
        Task.detached {
            do { box.result = .success(try await work()) } catch { box.result = .failure(error) }
            semaphore.signal()
        }
        semaphore.wait()
        return box.result
    }

    static func probe(_ url: URL) -> [String: Any] {
        var info: [String: Any] = ["name": url.lastPathComponent]
        let asset = AVURLAsset(url: url)
        let loaded = load { () -> ([AVAssetTrack], CMTime) in
            (try await asset.load(.tracks), try await asset.load(.duration))
        }
        guard case let .success((tracks, duration)) = loaded else {
            if case let .failure(e) = loaded { info["error"] = "load: \(e.localizedDescription)" }
            return info
        }
        guard let track = tracks.first(where: { $0.mediaType == .video }) ?? tracks.first(where: { $0.mediaType == .audio }) else {
            info["error"] = "no-tracks"
            return info
        }
        if duration.isNumeric { info["assetDurationMs"] = duration.seconds * 1000 }
        if track.mediaType == .video {
            info["kind"] = "video"
            if case let .success(size) = load({ try await track.load(.naturalSize) }) {
                info["width"] = Int(size.width)
                info["height"] = Int(size.height)
            }
        } else {
            info["kind"] = "audio"
            if case let .success(formats) = load({ try await track.load(.formatDescriptions) }),
               let f = formats.first, let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(f)?.pointee {
                info["sampleRate"] = asbd.mSampleRate
                info["channels"] = Int(asbd.mChannelsPerFrame)
            }
        }

        let reader: AVAssetReader
        do { reader = try AVAssetReader(asset: asset) } catch {
            info["error"] = "reader: \(error.localizedDescription)"
            return info
        }
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil) // samples in their storage format
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { info["error"] = "reader: output"; return info }
        reader.add(output)
        guard reader.startReading() else {
            info["error"] = "reader: \(reader.error?.localizedDescription ?? "start")"
            return info
        }
        var first = Double.infinity
        var end = -Double.infinity
        var samples = 0
        while let buffer = output.copyNextSampleBuffer() {
            let count = CMSampleBufferGetNumSamples(buffer)
            let pts = CMSampleBufferGetOutputPresentationTimeStamp(buffer)
            guard count > 0, pts.isNumeric else { continue }
            let length = CMSampleBufferGetOutputDuration(buffer)
            first = min(first, pts.seconds)
            end = max(end, pts.seconds + (length.isNumeric ? length.seconds : 0))
            samples += count
        }
        if reader.status == .failed { info["readError"] = reader.error?.localizedDescription ?? "failed" }
        reader.cancelReading()
        guard samples > 0, first.isFinite, end >= first else {
            info["error"] = (info["readError"] as? String) ?? "no-samples"
            return info
        }
        info["samples"] = samples
        info["firstMs"] = first * 1000
        info["durationMs"] = (end - first) * 1000
        return info
    }
}
