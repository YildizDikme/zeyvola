import AppKit
import CoreMedia
import Foundation
import ScreenCaptureKit

/// What to record, as chosen by the user in the app.
struct CaptureTarget {
    enum Kind { case display, window }
    let kind: Kind
    let displayID: CGDirectDisplayID?
    let windowID: CGWindowID?
    /// Display points relative to the display's top-left (region recording).
    let region: CGRect?
}

/// Screen (and optionally system audio) through ScreenCaptureKit. macOS asks the user for
/// "Screen & System Audio Recording" permission and shows its recording indicator.
/// The pointer is not drawn into the video; the app draws it from the cursor log.
final class ScreenSource: NSObject, SCStreamOutput, SCStreamDelegate {
    let videoQueue = DispatchQueue(label: "zeyvola.screen")
    let audioQueue = DispatchQueue(label: "zeyvola.system-audio")
    private var stream: SCStream?
    private(set) var pixelSize = (width: 0, height: 0)
    /// Window frame in global top-left points at start (window recording).
    private(set) var windowFrame: CGRect?

    var onVideo: ((CVPixelBuffer, Double) -> Void)?
    var onAudio: ((CMSampleBuffer, Double) -> Void)?
    var onInterrupted: ((Error) -> Void)?

    func prepare(target: CaptureTarget, fps: Int, quality: String, systemAudio: Bool, excludeOwnAudio: Bool, excludePid: pid_t?,
                 completion: @escaping (Error?) -> Void) {
        Output.log("screen: asking for shareable content")
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { [self] content, error in
            Output.log("screen: shareable content \(content == nil ? "missing: \(String(describing: error))" : "received")")
            guard let content = content else {
                completion(RecorderError("screen-permission", "Ekran kaydı izni yok veya ekran içeriği alınamadı: \(error?.localizedDescription ?? "?")"))
                return
            }
            do {
                let config = SCStreamConfiguration()
                let filter: SCContentFilter
                var points: CGSize
                var scale: CGFloat = 2
                switch target.kind {
                case .display:
                    guard let id = target.displayID, let display = content.displays.first(where: { $0.displayID == id }) else {
                        throw RecorderError("display-not-found", "Seçilen ekran bulunamadı.")
                    }
                    // Zeyvola's own windows (recording bar, editor) never appear in the recording.
                    let own = content.applications.filter { excludePid != nil && $0.processID == excludePid! }
                    filter = SCContentFilter(display: display, excludingApplications: own, exceptingWindows: [])
                    scale = backingScale(displayID: id)
                    points = CGSize(width: display.width, height: display.height)
                    if let r = target.region {
                        config.sourceRect = r
                        points = r.size
                    }
                case .window:
                    guard let id = target.windowID, let window = content.windows.first(where: { $0.windowID == id }) else {
                        throw RecorderError("window-not-found", "Seçilen pencere bulunamadı.")
                    }
                    filter = SCContentFilter(desktopIndependentWindow: window)
                    points = window.frame.size
                    windowFrame = window.frame
                    scale = NSScreen.screens.first(where: { $0.frame.intersects(flipToAppKit(window.frame)) })?.backingScaleFactor ?? 2
                }
                let size = capturePixelSize(points: points, scale: scale, quality: quality)
                pixelSize = size
                config.width = size.width
                config.height = size.height
                config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
                config.showsCursor = false
                config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
                config.colorSpaceName = CGColorSpace.sRGB
                config.queueDepth = 6
                if systemAudio {
                    config.capturesAudio = true
                    config.sampleRate = 48_000
                    config.channelCount = 2
                    // Zeyvola's own sounds stay out of the recording by default.
                    config.excludesCurrentProcessAudio = excludeOwnAudio
                }
                let s = SCStream(filter: filter, configuration: config, delegate: self)
                try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: videoQueue)
                if systemAudio { try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue) }
                stream = s
                Output.log("screen: starting capture \(size.width)x\(size.height) @\(fps)")
                // macOS normally answers within a second. If it does not (screen capture
                // unavailable, a system prompt still open), say so instead of waiting forever.
                let once = Once()
                DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
                    guard once.claim() else { return }
                    Output.log("screen: capture start timed out")
                    completion(RecorderError("screen-start-timeout", "macOS ekran yakalamayı 20 saniyede başlatmadı."))
                }
                s.startCapture { error in
                    Output.log("screen: capture start \(error == nil ? "ok" : "failed: \(String(describing: error))")")
                    guard once.claim() else { return }
                    if let error = error {
                        completion(RecorderError("screen-start", "Ekran kaydı başlatılamadı: \(error.localizedDescription)"))
                    } else {
                        completion(nil)
                    }
                }
            } catch {
                completion(error)
            }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard CMSampleBufferIsValid(sample) else { return }
        let host = CMSampleBufferGetPresentationTimeStamp(sample).seconds
        switch type {
        case .screen:
            // Only complete frames carry an image; idle frames mean "nothing changed".
            guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let raw = attachments.first?[.status] as? Int,
                  SCFrameStatus(rawValue: raw) == .complete,
                  let pixelBuffer = CMSampleBufferGetImageBuffer(sample) else { return }
            onVideo?(pixelBuffer, host)
        case .audio:
            onAudio?(sample, host)
        default:
            break
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onInterrupted?(error)
    }

    func stop(completion: @escaping () -> Void) {
        guard let s = stream else { completion(); return }
        stream = nil
        s.stopCapture { _ in completion() }
    }
}

func backingScale(displayID: CGDirectDisplayID) -> CGFloat {
    for screen in NSScreen.screens {
        if let n = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber, n.uint32Value == displayID {
            return screen.backingScaleFactor
        }
    }
    return 2
}

/// Global top-left points (ScreenCaptureKit, Electron) → AppKit bottom-left points.
func flipToAppKit(_ r: CGRect) -> CGRect {
    let h = NSScreen.screens.first?.frame.height ?? 0
    return CGRect(x: r.minX, y: h - r.maxY, width: r.width, height: r.height)
}

/// Lets exactly one of several racing callbacks through.
final class Once {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}
