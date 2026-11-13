import AppKit
import Foundation

// Zeyvola pointer helper (macOS).
//
// Started by the Zeyvola app while a screen recording runs, so the editor knows where and when
// the user clicked (automatic zoom). It reports mouse button and scroll events only: it records
// no video, no audio and never reads the keyboard. It links only AppKit and Foundation, writes
// nothing to disk and makes no network requests. Watching mouse events with a global monitor
// needs no extra macOS permission (keyboard events would; they are not requested).
//
// zeyvola-input [--window <CGWindowID>]
// With --window (a window recording) it also reports where that window is, so the app can make
// positions relative to it: CGWindowListCopyWindowInfo for that one window, read about 30 times a
// second, written when its bounds change. Window bounds need no permission either; the window's
// title and contents are not read.
//
// stdout, one JSON object per line:
//   {"type":"window","at":<s>,"now":<s>,"gx":<pt>,"gy":<pt>,"w":<pt>,"h":<pt>}   window bounds (--window)
//   {"type":"ready","now":<s>}
//   {"e":"d"|"u","b":"l"|"r"|"o","at":<s>,"now":<s>,"gx":<pt>,"gy":<pt>}   button down / up
//   {"e":"s","dy":<pt>,"at":<s>,"now":<s>,"gx":<pt>,"gy":<pt>}           scroll
//   {"type":"error","code":"monitor"}                                     monitor could not start
// at = event time, now = time of writing, both in seconds since the Mac started (the clock of
// NSEvent.timestamp); the app maps them to its recording clock. gx/gy are global points with a
// top-left origin on the main display, like Electron's screen coordinates; for a window they are
// its top-left corner (kCGWindowBounds, without the shadow).
// Exits when stdin closes or a "stop" line arrives.

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

func uptime() -> Double { ProcessInfo.processInfo.systemUptime }

/// Pointer position as global top-left points.
func pointer() -> CGPoint {
    let p = NSEvent.mouseLocation
    let h = NSScreen.screens.first?.frame.height ?? 0
    return CGPoint(x: p.x, y: h - p.y)
}

var buttons = 0

/// Writes a button change once; repeated reports of the same state are ignored.
func button(_ bit: Int, down: Bool, at: Double) {
    guard (buttons & bit != 0) != down else { return }
    buttons = down ? buttons | bit : buttons & ~bit
    let p = pointer()
    let code = bit == 1 ? "l" : bit == 2 ? "r" : "o"
    emit(String(format: "{\"e\":\"%@\",\"b\":\"%@\",\"at\":%.6f,\"now\":%.6f,\"gx\":%.2f,\"gy\":%.2f}",
                down ? "d" : "u", code, at, uptime(), p.x, p.y))
}

/// The window to follow (--window <id>), if any.
let windowID: CGWindowID? = {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: "--window"), i + 1 < args.count, let id = UInt32(args[i + 1]), id != 0 else { return nil }
    return CGWindowID(id)
}()
var lastBounds = CGRect.null

/// Writes the window's bounds when they changed. A window that is gone keeps its last bounds.
func reportWindow(_ id: CGWindowID) {
    let at = uptime()
    guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]],
          let value = list.first?[kCGWindowBounds as String], value is [String: Any],
          let r = CGRect(dictionaryRepresentation: value as! CFDictionary),
          r.width > 0, r.height > 0, r != lastBounds else { return }
    lastBounds = r
    emit(String(format: "{\"type\":\"window\",\"at\":%.6f,\"now\":%.6f,\"gx\":%.2f,\"gy\":%.2f,\"w\":%.2f,\"h\":%.2f}",
                at, uptime(), r.minX, r.minY, r.width, r.height))
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

let mask: NSEvent.EventTypeMask = [.scrollWheel, .leftMouseDown, .leftMouseUp, .rightMouseDown,
                                   .rightMouseUp, .otherMouseDown, .otherMouseUp]
let monitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { event in
    switch event.type {
    case .leftMouseDown: button(1, down: true, at: event.timestamp)
    case .leftMouseUp: button(1, down: false, at: event.timestamp)
    case .rightMouseDown: button(2, down: true, at: event.timestamp)
    case .rightMouseUp: button(2, down: false, at: event.timestamp)
    case .otherMouseDown: button(4, down: true, at: event.timestamp)
    case .otherMouseUp: button(4, down: false, at: event.timestamp)
    case .scrollWheel:
        let p = pointer()
        emit(String(format: "{\"e\":\"s\",\"dy\":%.3f,\"at\":%.6f,\"now\":%.6f,\"gx\":%.2f,\"gy\":%.2f}",
                    Double(event.scrollingDeltaY), event.timestamp, uptime(), p.x, p.y))
    default: break
    }
}
guard let monitor else {
    emit("{\"type\":\"error\",\"code\":\"monitor\"}")
    exit(2)
}
// Kept in a global so the timer lives as long as the process.
let windowTimer: DispatchSourceTimer? = windowID.map { id in
    reportWindow(id)  // before "ready", so the app knows the bounds when recording starts
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + 1.0 / 30.0, repeating: 1.0 / 30.0)
    timer.setEventHandler { reportWindow(id) }
    timer.resume()
    return timer
}
emit(String(format: "{\"type\":\"ready\",\"now\":%.6f}", uptime()))

// Stop on "stop" or when the app closes our stdin (including when the app quits).
Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        if line.trimmingCharacters(in: .whitespaces) == "stop" { break }
    }
    DispatchQueue.main.async {
        NSEvent.removeMonitor(monitor)
        exit(0)
    }
}
app.run()
