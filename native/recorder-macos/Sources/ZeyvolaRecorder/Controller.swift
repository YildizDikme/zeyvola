import AppKit
import AVFoundation
import CoreGraphics
import Foundation

/// Reads commands from the Zeyvola app (one JSON object per line on stdin):
///   prepare {outDir, display|window, region?, bounds, fps, quality, camera?, mic?, systemAudio, excludePid}
///   go | start (prepare + go) | pause | resume | mark | stop | cancel
///   request-access {screen?, camera?, mic?}  (system permission dialogs only)
/// If the app goes away (stdin closes), a running recording is finished and saved first.
final class Controller {
    private var session: RecordingSession?

    func run() {
        Thread.detachNewThread { [self] in
            while let line = readLine(strippingNewline: true) {
                guard let data = line.data(using: .utf8),
                      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let cmd = object["cmd"] as? String else { continue }
                DispatchQueue.main.async { self.handle(cmd, object) }
            }
            DispatchQueue.main.async { self.parentGone() }
        }
    }

    private func fail(_ error: Error, fatal: Bool) {
        if let e = error as? RecorderError { Output.error(e.code, e.message, fatal: fatal) }
        else { Output.error("internal", "\(error)", fatal: fatal) }
    }

    private func prepare(_ object: [String: Any], then go: Bool) {
        guard session == nil else { Output.error("busy", "Zaten bir kayıt hazırlanıyor.", fatal: false); return }
        do {
            let s = try RecordingSession(object)
            session = s
            s.prepare { [self] error in
                if let error = error {
                    session = nil
                    fail(error, fatal: true)
                    return
                }
                var ready: [String: Any] = ["type": "ready"]
                for (k, v) in s.info { ready[k] = v }
                Output.send(ready)
                if go {
                    do { try s.go() } catch { fail(error, fatal: true) }
                }
            }
        } catch {
            session = nil
            fail(error, fatal: true)
        }
    }

    private func handle(_ cmd: String, _ object: [String: Any]) {
        switch cmd {
        case "prepare": prepare(object, then: false)
        case "start": prepare(object, then: true)
        case "go":
            guard let s = session else { Output.error("no-session", "Hazırlanmış kayıt yok.", fatal: true); return }
            do { try s.go() } catch { fail(error, fatal: true) }
        case "request-access": requestAccessAll(object)
        case "pause": session?.pause()
        case "resume": session?.resume()
        case "mark": session?.mark()
        case "stop":
            guard let s = session else { Output.error("no-session", "Kayıt yok.", fatal: true); return }
            s.stop { [self] result in
                Output.send(result)
                // Finished: closing stdin now simply ends the helper.
                if session === s { session = nil }
            }
        case "cancel":
            session?.teardown()
            session = nil
            Output.send(["type": "cancelled"])
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { exit(0) }
        default:
            Output.error("unknown-command", "Bilinmeyen komut: \(cmd)", fatal: false)
        }
    }

    /// Shows macOS's own permission dialogs for what the app asks for (nothing is captured).
    /// Screen recording takes effect after Zeyvola restarts; macOS says so in its dialog.
    private func requestAccessAll(_ object: [String: Any]) {
        var result: [String: Any] = ["type": "access"]
        if (object["screen"] as? Bool) == true {
            result["screen"] = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() ? "granted" : "not-granted"
        }
        let group = DispatchGroup()
        let lock = NSLock()
        for (key, type) in [("camera", AVMediaType.video), ("mic", AVMediaType.audio)] where (object[key] as? Bool) == true {
            group.enter()
            requestAccess(type) { ok in
                lock.lock(); result[key] = ok ? "granted" : authorization(type); lock.unlock()
                group.leave()
            }
        }
        group.notify(queue: .main) { Output.send(result) }
    }

    private func parentGone() {
        guard let s = session, s.started else { exit(0) }
        s.stop { result in
            Output.send(result)
            exit(0)
        }
    }
}
