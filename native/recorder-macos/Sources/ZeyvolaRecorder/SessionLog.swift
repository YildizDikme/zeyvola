import Foundation

/// The recording's sidecar file, `session.jsonl`, from which the app rebuilds a recording when
/// the helper dies before it could send "stopped". One JSON object per line; every line is
/// written and synced to disk before the call returns, so whatever the helper knew survives
/// a crash. The Windows helper writes the same format.
///
///   {"e":"session","v":1,"startedAtMs":…,"pid":…,"helper":…,"version":…,"platform":"macos","fps":…,"cursor":"cursor.jsonl","meta":{…}}
///   {"e":"track","kind":"screen","name":"screen.mp4","mime":"video/mp4","startOffsetMs":0,"width":…,"height":…,"fps":…}
///   {"e":"track","kind":"mic","name":"mic.m4a","mime":"audio/mp4","startOffsetMs":7.2,"sampleRate":48000,"channels":1}
///   {"e":"pause","t":ticks,"atMs":…}  {"e":"resume","t":ticks,"atMs":…}  {"e":"mark","t":ticks}
///   {"e":"end","durationMs":…}        files closed normally
///   {"e":"cancelled"}                 nothing is to be kept
///
/// `meta` is the app's own description of the recording (from "prepare"), stored unchanged.
/// A track line is written when its file receives its first sample, before the first
/// 2-second fragment can reach the disk.
final class SessionLog {
    static let fileName = "session.jsonl"
    private let url: URL
    private let lock = NSLock()
    private var handle: FileHandle?
    private var closed = false

    init(directory: URL) {
        url = directory.appendingPathComponent(SessionLog.fileName)
    }

    /// Creates the file with its first line. Lines written before this are ignored.
    func begin(_ header: [String: Any]) throws {
        lock.lock(); defer { lock.unlock() }
        guard handle == nil, !closed else { return }
        guard FileManager.default.createFile(atPath: url.path, contents: nil),
              let h = FileHandle(forWritingAtPath: url.path) else {
            throw RecorderError("session-file", "Kayıt yan dosyası oluşturulamadı.")
        }
        handle = h
        try append(header, to: h)
    }

    /// Appends one line and syncs it. Called from any queue; failures are logged, not fatal,
    /// because the recording itself goes on.
    func write(_ object: [String: Any]) {
        lock.lock(); defer { lock.unlock() }
        guard let h = handle, !closed else { return }
        do { try append(object, to: h) } catch { Output.log("[session] \(error)") }
    }

    func close() {
        lock.lock(); defer { lock.unlock() }
        closed = true
        try? handle?.close()
        handle = nil
    }

    private func append(_ object: [String: Any], to h: FileHandle) throws {
        guard JSONSerialization.isValidJSONObject(object) else { return }
        var data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        data.append(0x0A)
        try h.write(contentsOf: data)
        try h.synchronize()
    }
}
