import Foundation

/// One JSON object per line on stdout; the Electron main process reads these.
enum Output {
    private static let queue = DispatchQueue(label: "zeyvola.output")

    static func send(_ object: [String: Any]) {
        queue.sync {
            guard JSONSerialization.isValidJSONObject(object),
                  let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0A]))
        }
    }

    static func error(_ code: String, _ message: String, fatal: Bool) {
        send(["type": "error", "code": code, "message": message, "fatal": fatal])
    }

    /// Diagnostics go to stderr; the app keeps the last lines for error reports.
    static func log(_ message: String) {
        FileHandle.standardError.write(Data("\(message)\n".utf8))
    }
}

struct RecorderError: Error, CustomStringConvertible {
    let code: String
    let message: String
    init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
    var description: String { "\(code): \(message)" }
}
