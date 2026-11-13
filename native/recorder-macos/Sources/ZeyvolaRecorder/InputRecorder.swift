import AppKit
import CoreGraphics
import Foundation

/// Pointer position and mouse buttons during a recording, for the editor's cursor effects and
/// the automatic zoom engine. Only the pointer is observed: the keyboard is never read.
/// Position and button state are polled from NSEvent (no extra permission). Button and
/// scroll events also come from a listen-only global monitor with their exact time, so a
/// trackpad tap that ends between two polls is still recorded; each button change is
/// written once, by whichever path sees it first.
///
/// Output: one JSON object per line, the app's cursor log format —
///   {"e":"m","t":ticks,"x":0..1,"y":0..1}   pointer moved
///   {"e":"d"|"u","t":..,"x":..,"y":..,"b":"l"|"r"|"o"}   button down / up
///   {"e":"s","t":..,"x":..,"y":..,"dy":..}   scroll
///   {"e":"k","t":..,"x":0,"y":0}             marker
/// x/y are relative to the recorded area (top-left origin) and may leave 0..1 when the
/// pointer is outside it, for example on another display.
final class InputRecorder {
    private let clock: SessionClock
    private let out: FileHandle
    private var bounds: CGRect
    private let windowID: CGWindowID?
    private var timer: Timer?
    private var monitor: Any?
    private var lastButtons = 0
    private var lastX = Double.nan
    private var lastY = Double.nan
    private var lastWrite: Int64 = 0
    private var lastBoundsCheck = 0.0
    private(set) var clicks = 0
    private(set) var samples = 0

    init(clock: SessionClock, file: URL, bounds: CGRect, windowID: CGWindowID?) throws {
        self.clock = clock
        self.bounds = bounds
        self.windowID = windowID
        FileManager.default.createFile(atPath: file.path, contents: nil)
        guard let h = FileHandle(forWritingAtPath: file.path) else { throw RecorderError("cursor-file", "İmleç dosyası açılamadı.") }
        out = h
    }

    func start() {
        let t = Timer(timeInterval: 1.0 / 120.0, repeats: true) { [weak self] _ in self?.sample() }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        let mask: NSEvent.EventTypeMask = [.scrollWheel, .leftMouseDown, .leftMouseUp, .rightMouseDown,
                                           .rightMouseUp, .otherMouseDown, .otherMouseUp]
        monitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] event in
            self?.event(event)
        }
    }

    private func write(_ line: String) {
        out.write(Data((line + "\n").utf8))
    }

    /// Global top-left points of the pointer (Electron/ScreenCaptureKit convention).
    private func pointerGlobal() -> CGPoint {
        let p = NSEvent.mouseLocation
        let h = NSScreen.screens.first?.frame.height ?? 0
        return CGPoint(x: p.x, y: h - p.y)
    }

    private func normalized(_ g: CGPoint) -> (Double, Double) {
        (Double((g.x - bounds.minX) / max(1, bounds.width)), Double((g.y - bounds.minY) / max(1, bounds.height)))
    }

    private func refreshWindowBounds(now: Double) {
        guard let id = windowID, now - lastBoundsCheck > 0.25 else { return }
        lastBoundsCheck = now
        guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]],
              let info = list.first, let dict = info[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: dict as CFDictionary) else { return }
        bounds = rect
    }

    private func sample() {
        let host = SessionClock.hostNow()
        guard let s = clock.sessionSeconds(host: host) else { return }
        refreshWindowBounds(now: host)
        let t = SessionClock.ticks(s)
        let (x, y) = normalized(pointerGlobal())
        // Skip unchanged samples but keep a 2 Hz heartbeat so idle stretches stay explicit.
        if x != lastX || y != lastY || t - lastWrite >= 352_800_000 {
            write(String(format: "{\"e\":\"m\",\"t\":%lld,\"x\":%.5f,\"y\":%.5f}", t, x, y))
            lastX = x
            lastY = y
            lastWrite = t
            samples += 1
        }
        let buttons = NSEvent.pressedMouseButtons
        for bit in [1, 2, 4] {
            button(bit, down: buttons & bit != 0, t: t, x: x, y: y)
        }
    }

    /// Records a button change once; later reports of the same state are ignored.
    private func button(_ bit: Int, down: Bool, t: Int64, x: Double, y: Double) {
        guard (lastButtons & bit != 0) != down else { return }
        lastButtons = down ? lastButtons | bit : lastButtons & ~bit
        let code = bit == 1 ? "l" : bit == 2 ? "r" : "o"
        write(String(format: "{\"e\":\"%@\",\"t\":%lld,\"x\":%.5f,\"y\":%.5f,\"b\":\"%@\"}", down ? "d" : "u", t, x, y, code))
        if down { clicks += 1 }
    }

    private func event(_ event: NSEvent) {
        let host = event.timestamp + clock.uptimeToHost
        guard let s = clock.sessionSeconds(host: host) else { return }
        let t = SessionClock.ticks(s)
        let (x, y) = normalized(pointerGlobal())
        switch event.type {
        case .scrollWheel:
            write(String(format: "{\"e\":\"s\",\"t\":%lld,\"x\":%.5f,\"y\":%.5f,\"dy\":%.3f}", t, x, y, Double(event.scrollingDeltaY)))
        case .leftMouseDown: button(1, down: true, t: t, x: x, y: y)
        case .leftMouseUp: button(1, down: false, t: t, x: x, y: y)
        case .rightMouseDown: button(2, down: true, t: t, x: x, y: y)
        case .rightMouseUp: button(2, down: false, t: t, x: x, y: y)
        case .otherMouseDown: button(4, down: true, t: t, x: x, y: y)
        case .otherMouseUp: button(4, down: false, t: t, x: x, y: y)
        default: break
        }
    }

    func marker(at seconds: Double) {
        write(String(format: "{\"e\":\"k\",\"t\":%lld,\"x\":0,\"y\":0}", SessionClock.ticks(seconds)))
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        if let m = monitor { NSEvent.removeMonitor(m) }
        monitor = nil
        try? out.synchronize()
        try? out.close()
    }
}
