import CoreMedia
import Foundation

/// The app's time unit: 705,600,000 ticks per second.
let ticksPerSecond: Double = 705_600_000

/// Recording time on the host clock. ScreenCaptureKit and AVFoundation stamp their samples
/// with this clock (camera and microphone are converted to it), so every source lines up.
/// Paused intervals are cut out, exactly like the app's own SessionClock.
final class SessionClock {
    private let lock = NSLock()
    private var t0: Double?
    private var pauses: [(start: Double, end: Double)] = []
    private var pausedAt: Double?
    private var stoppedAt: Double?

    /// NSEvent timestamps and ProcessInfo.systemUptime share one base; this maps them to host time.
    let uptimeToHost: Double

    init() {
        uptimeToHost = SessionClock.hostNow() - ProcessInfo.processInfo.systemUptime
    }

    static func hostNow() -> Double {
        CMClockGetTime(CMClockGetHostTimeClock()).seconds
    }

    func start(at host: Double = SessionClock.hostNow()) {
        lock.lock(); defer { lock.unlock() }
        t0 = host
        pauses = []
        pausedAt = nil
        stoppedAt = nil
    }

    func pause(at host: Double = SessionClock.hostNow()) {
        lock.lock(); defer { lock.unlock() }
        if t0 != nil, pausedAt == nil { pausedAt = host }
    }

    func resume(at host: Double = SessionClock.hostNow()) {
        lock.lock(); defer { lock.unlock() }
        if let p = pausedAt {
            pauses.append((p, host))
            pausedAt = nil
        }
    }

    /// After stop, no further samples are accepted.
    func stop(at host: Double = SessionClock.hostNow()) {
        lock.lock(); defer { lock.unlock() }
        if stoppedAt == nil { stoppedAt = host }
    }

    var isRecording: Bool {
        lock.lock(); defer { lock.unlock() }
        return t0 != nil && pausedAt == nil && stoppedAt == nil
    }

    var isStarted: Bool {
        lock.lock(); defer { lock.unlock() }
        return t0 != nil
    }

    /// Session seconds for a host timestamp; nil before start, inside a pause or after stop.
    func sessionSeconds(host: Double) -> Double? {
        lock.lock(); defer { lock.unlock() }
        guard let t0 = t0, host >= t0 else { return nil }
        if let s = stoppedAt, host >= s { return nil }
        if let p = pausedAt, host >= p { return nil }
        var removed = 0.0
        for iv in pauses {
            if host >= iv.end { removed += iv.end - iv.start }
            else if host >= iv.start { return nil }
        }
        return host - t0 - removed
    }

    /// Elapsed recording time (pauses removed) at a host time, clamped to the stop time.
    func elapsed(at host: Double = SessionClock.hostNow()) -> Double {
        lock.lock(); defer { lock.unlock() }
        guard let t0 = t0 else { return 0 }
        let end = min(host, stoppedAt ?? host, pausedAt ?? host)
        let removed = pauses.reduce(0.0) { $0 + ($1.end - $1.start) }
        return max(0, end - t0 - removed)
    }

    static func ticks(_ seconds: Double) -> Int64 {
        Int64((seconds * ticksPerSecond).rounded())
    }
}
