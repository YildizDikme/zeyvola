import AppKit
import CoreMedia
import Foundation

/// One recording, started by the user from the Zeyvola app. Sources open and warm up during
/// the countdown ("prepare"); "go" starts the shared clock, after which every source writes
/// its own file. Stopping (or losing the app) always finishes the files so they stay playable.
/// Everything needed to rebuild the recording after a crash goes into the session log as it
/// happens (see SessionLog).
final class RecordingSession {
    private let clock = SessionClock()
    private let outDir: URL
    private let target: CaptureTarget
    private let bounds: CGRect
    private let fps: Int
    private let quality: String
    private let systemAudio: Bool
    private let excludeOwnAudio: Bool
    private let excludePid: pid_t?
    private let cameraLabel: String?
    private let micLabel: String?
    private let wantsCamera: Bool
    private let wantsMic: Bool
    /// The app's description of the recording, kept in the session log for recovery.
    private let meta: [String: Any]?
    private let log: SessionLog

    private let screen = ScreenSource()
    private var camera: CameraSource?
    private var mic: MicSource?
    private var writers: [TrackWriter] = []
    private var input: InputRecorder?
    private var markers: [Int64] = []
    private var statusTimer: Timer?
    /// Latest screen frame from the warm-up, used as the first frame when the screen is still
    /// at "go" (ScreenCaptureKit only delivers new frames when something on screen changes).
    private final class FrameBox { var frame: CVPixelBuffer? }
    private let warmup = FrameBox()
    private(set) var started = false
    private var stopping = false

    init(_ cmd: [String: Any]) throws {
        guard let dir = cmd["outDir"] as? String, !dir.isEmpty else { throw RecorderError("bad-command", "outDir eksik") }
        outDir = URL(fileURLWithPath: dir, isDirectory: true)
        let rect = { (v: Any?) -> CGRect? in
            guard let d = v as? [String: Any], let x = d["x"] as? Double, let y = d["y"] as? Double,
                  let w = d["w"] as? Double, let h = d["h"] as? Double, w > 0, h > 0 else { return nil }
            return CGRect(x: x, y: y, width: w, height: h)
        }
        if let w = cmd["window"] as? NSNumber {
            target = CaptureTarget(kind: .window, displayID: nil, windowID: CGWindowID(w.uint32Value), region: nil)
        } else if let d = cmd["display"] as? NSNumber {
            target = CaptureTarget(kind: .display, displayID: CGDirectDisplayID(d.uint32Value), windowID: nil, region: rect(cmd["region"]))
        } else {
            throw RecorderError("bad-command", "Ekran veya pencere seçilmedi")
        }
        bounds = rect(cmd["bounds"]) ?? .zero
        fps = (cmd["fps"] as? Int) == 60 ? 60 : 30
        quality = (cmd["quality"] as? String) ?? "high"
        systemAudio = (cmd["systemAudio"] as? Bool) ?? false
        excludeOwnAudio = (cmd["excludeOwnAudio"] as? Bool) ?? true
        excludePid = (cmd["excludePid"] as? NSNumber).map { pid_t($0.int32Value) }
        let cam = cmd["camera"] as? [String: Any]
        let m = cmd["mic"] as? [String: Any]
        wantsCamera = cam != nil
        wantsMic = m != nil
        cameraLabel = cam?["label"] as? String
        micLabel = m?["label"] as? String
        meta = (cmd["meta"] as? [String: Any]).flatMap { JSONSerialization.isValidJSONObject($0) ? $0 : nil }
        log = SessionLog(directory: outDir)
    }

    func prepare(completion: @escaping (Error?) -> Void) {
        do {
            try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        } catch {
            completion(RecorderError("out-dir", "Kayıt klasörü oluşturulamadı: \(error.localizedDescription)"))
            return
        }
        let group = DispatchGroup()
        let lock = NSLock()
        var firstError: Error?
        let done: (Error?) -> Void = { e in
            if let e = e { lock.lock(); if firstError == nil { firstError = e }; lock.unlock() }
            group.leave()
        }
        group.enter()
        screen.prepare(target: target, fps: fps, quality: quality, systemAudio: systemAudio, excludeOwnAudio: excludeOwnAudio, excludePid: excludePid, completion: done)
        if wantsCamera {
            let c = CameraSource()
            camera = c
            group.enter()
            c.prepare(label: cameraLabel, quality: quality, completion: done)
        }
        if wantsMic {
            let m = MicSource()
            mic = m
            group.enter()
            m.prepare(label: micLabel, completion: done)
        }
        group.notify(queue: .main) { [self] in
            if let e = firstError {
                teardown()
                completion(e)
                return
            }
            wire()
            completion(nil)
        }
    }

    /// Facts about the opened sources, sent with "ready".
    var info: [String: Any] {
        var i: [String: Any] = ["screenWidth": screen.pixelSize.width, "screenHeight": screen.pixelSize.height]
        if let c = camera { i["camera"] = c.deviceName }
        if let m = mic { i["mic"] = m.deviceName }
        return i
    }

    private func wire() {
        let clock = self.clock
        let log = self.log
        let sw = TrackWriter(source: "screen", fileName: "screen.mp4", mime: "video/mp4", directory: outDir,
                             kind: .video(fps: fps, quality: quality), queue: screen.videoQueue, log: log)
        writers.append(sw)
        let warmup = self.warmup
        screen.onVideo = { pixelBuffer, host in
            guard let t = clock.sessionSeconds(host: host) else {
                if !clock.isStarted { warmup.frame = pixelBuffer }
                return
            }
            warmup.frame = nil
            sw.appendVideo(pixelBuffer, at: t)
        }
        if systemAudio {
            let aw = TrackWriter(source: "system", fileName: "system.m4a", mime: "audio/mp4", directory: outDir,
                                 kind: .audio(sampleRate: 48_000, channels: 2, bitrate: 160_000), queue: screen.audioQueue, log: log)
            writers.append(aw)
            screen.onAudio = { sample, host in
                guard let t = clock.sessionSeconds(host: host) else { return }
                aw.appendAudio(sample, at: t)
            }
        }
        screen.onInterrupted = { [weak self] error in
            DispatchQueue.main.async { self?.interrupted(error) }
        }
        if let c = camera {
            let cw = TrackWriter(source: "camera", fileName: "camera.mp4", mime: "video/mp4", directory: outDir,
                                 kind: .video(fps: 30, quality: quality), queue: c.queue, log: log)
            writers.append(cw)
            c.onFrame = { pixelBuffer, host in
                guard let t = clock.sessionSeconds(host: host) else { return }
                cw.appendVideo(pixelBuffer, at: t)
            }
        }
        if let m = mic {
            let mw = TrackWriter(source: "mic", fileName: "mic.m4a", mime: "audio/mp4", directory: outDir,
                                 kind: .audio(sampleRate: 48_000, channels: 1, bitrate: 128_000), queue: m.queue, log: log)
            writers.append(mw)
            m.onAudio = { sample, host in
                guard let t = clock.sessionSeconds(host: host) else { return }
                mw.appendAudio(sample, at: t)
            }
        }
    }

    func go() throws {
        guard !started else { return }
        let area = target.kind == .window ? (screen.windowFrame ?? bounds) : bounds
        let recorder = try InputRecorder(clock: clock, file: outDir.appendingPathComponent("cursor.jsonl"), bounds: area, windowID: target.windowID)
        // Written before the clock starts, so it precedes every track line.
        var header: [String: Any] = [
            "e": "session", "v": 1, "startedAtMs": Date().timeIntervalSince1970 * 1000,
            "pid": Int(ProcessInfo.processInfo.processIdentifier), "helper": "zeyvola-recorder", "version": version,
            "platform": "macos", "fps": fps, "cursor": "cursor.jsonl",
        ]
        if let meta = meta { header["meta"] = meta }
        try log.begin(header)
        clock.start()
        recorder.start()
        if let sw = writers.first(where: { $0.source == "screen" }) {
            let warmup = self.warmup
            screen.videoQueue.async {
                if sw.appended == 0, let frame = warmup.frame { sw.appendVideo(frame, at: 0) }
                warmup.frame = nil
            }
        }
        input = recorder
        started = true
        let t = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in self?.sendStatus() }
        RunLoop.main.add(t, forMode: .common)
        statusTimer = t
        Output.send(["type": "started", "startedAtMs": Date().timeIntervalSince1970 * 1000])
    }

    private func sendStatus() {
        let dropped = writers.reduce(0) { $0 + $1.dropped }
        Output.send(["type": "status", "elapsedMs": clock.elapsed() * 1000, "micLevel": Double(mic?.level ?? 0), "dropped": dropped])
    }

    func pause() {
        clock.pause()
        if started { log.write(["e": "pause", "t": SessionClock.ticks(clock.elapsed()), "atMs": Date().timeIntervalSince1970 * 1000]) }
    }

    func resume() {
        clock.resume()
        if started { log.write(["e": "resume", "t": SessionClock.ticks(clock.elapsed()), "atMs": Date().timeIntervalSince1970 * 1000]) }
    }

    func mark() {
        guard started else { return }
        let s = clock.elapsed()
        markers.append(SessionClock.ticks(s))
        input?.marker(at: s)
        log.write(["e": "mark", "t": SessionClock.ticks(s)])
    }

    /// The screen stream stopped by itself (permission withdrawn, display removed, …).
    /// The app is told and stops the recording, which keeps everything captured so far.
    private func interrupted(_ error: Error) {
        guard !stopping else { return }
        Output.send(["type": "interrupted", "code": "screen-stopped", "message": "Ekran kaydı sistem tarafından durduruldu: \(error.localizedDescription)"])
    }

    func stop(completion: @escaping ([String: Any]) -> Void) {
        guard !stopping else { return }
        stopping = true
        let end = clock.elapsed()
        clock.stop()
        statusTimer?.invalidate()
        input?.stop()
        camera?.stop()
        mic?.stop()
        screen.stop { [self] in
            let group = DispatchGroup()
            let lock = NSLock()
            var files: [[String: Any]] = []
            for w in writers {
                group.enter()
                w.queue.async {
                    w.finish(end: end) { info in
                        if let info = info { lock.lock(); files.append(info); lock.unlock() }
                        group.leave()
                    }
                }
            }
            group.notify(queue: .main) { [self] in
                log.write(["e": "end", "durationMs": end * 1000])
                log.close()
                completion([
                    "type": "stopped",
                    "durationMs": end * 1000,
                    "files": files,
                    "cursor": input != nil ? "cursor.jsonl" : NSNull(),
                    "markers": markers,
                    "hasClicks": input != nil,
                    "clicks": input?.clicks ?? 0,
                    "cursorSamples": input?.samples ?? 0,
                ])
            }
        }
    }

    /// Releases devices without keeping anything (failed prepare or cancel).
    func teardown() {
        if started { log.write(["e": "cancelled"]) }
        log.close()
        stopping = true
        clock.stop()
        statusTimer?.invalidate()
        input?.stop()
        camera?.stop()
        mic?.stop()
        screen.stop {}
    }
}
