import AVFoundation
import CoreMedia
import Foundation

/// Picks the AVFoundation device for a device name chosen in the app. Browser device names
/// sometimes carry extra text (for example a USB id in parentheses), so prefix and
/// containment matches are accepted; without a match the system default is used.
func matchDevice(_ devices: [AVCaptureDevice], label: String?, fallback: AVCaptureDevice?) -> AVCaptureDevice? {
    guard let label = label?.trimmingCharacters(in: .whitespaces), !label.isEmpty else { return fallback ?? devices.first }
    let names = devices.map { ($0, $0.localizedName) }
    return matchName(names, label: label) ?? fallback ?? devices.first
}

func matchName<T>(_ items: [(T, String)], label: String) -> T? {
    let l = label.lowercased()
    if let hit = items.first(where: { $0.1.lowercased() == l }) { return hit.0 }
    if let hit = items.first(where: { l.hasPrefix($0.1.lowercased()) || $0.1.lowercased().hasPrefix(l) }) { return hit.0 }
    if let hit = items.first(where: { l.contains($0.1.lowercased()) || $0.1.lowercased().contains(l) }) { return hit.0 }
    return nil
}

/// Cameras or microphones currently connected (built-in, USB and Continuity devices).
func captureDevices(_ type: AVMediaType) -> [AVCaptureDevice] {
    let types: [AVCaptureDevice.DeviceType]
    if #available(macOS 14.0, *) {
        types = type == .video ? [.builtInWideAngleCamera, .external, .continuityCamera] : [.microphone]
    } else {
        types = type == .video ? [.builtInWideAngleCamera, .externalUnknown] : [.builtInMicrophone, .externalUnknown]
    }
    return AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: type, position: .unspecified).devices
}

/// Asks macOS for camera or microphone access with the normal system dialog (once); the
/// answer is remembered by macOS for the Zeyvola app.
func requestAccess(_ type: AVMediaType, completion: @escaping (Bool) -> Void) {
    switch AVCaptureDevice.authorizationStatus(for: type) {
    case .authorized: completion(true)
    case .notDetermined: AVCaptureDevice.requestAccess(for: type, completionHandler: completion)
    default: completion(false)
    }
}

private func hostSeconds(_ pts: CMTime, session: AVCaptureSession) -> Double {
    CMSyncConvertTime(pts, from: session.synchronizationClock ?? CMClockGetHostTimeClock(), to: CMClockGetHostTimeClock()).seconds
}

/// Camera, recorded separately from the screen.
final class CameraSource: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let queue = DispatchQueue(label: "zeyvola.camera")
    private let session = AVCaptureSession()
    private(set) var size = (width: 1280, height: 720)
    private(set) var deviceName = ""
    var onFrame: ((CVPixelBuffer, Double) -> Void)?

    /// quality "standard" records 720p; "high" and "max" 1080p when the camera offers it, so a
    /// camera shown large (dynamic camera) stays sharp.
    func prepare(label: String?, quality: String, completion: @escaping (Error?) -> Void) {
        requestAccess(.video) { [self] granted in
            guard granted else {
                completion(RecorderError("camera-permission", "Kamera izni verilmedi."))
                return
            }
            queue.async { [self] in
                do {
                    let devices = captureDevices(.video)
                    guard let device = matchDevice(devices, label: label, fallback: AVCaptureDevice.default(for: .video)) else {
                        throw RecorderError("camera-not-found", "Kamera bulunamadı.")
                    }
                    deviceName = device.localizedName
                    session.beginConfiguration()
                    let input = try AVCaptureDeviceInput(device: device)
                    guard session.canAddInput(input) else { throw RecorderError("camera-busy", "Kamera açılamadı.") }
                    session.addInput(input)
                    let output = AVCaptureVideoDataOutput()
                    output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
                    output.alwaysDiscardsLateVideoFrames = true
                    output.setSampleBufferDelegate(self, queue: queue)
                    guard session.canAddOutput(output) else { throw RecorderError("camera-busy", "Kamera açılamadı.") }
                    session.addOutput(output)
                    // The preset applies to the device that was just added.
                    let preset: AVCaptureSession.Preset = quality == "standard" ? .hd1280x720 : .hd1920x1080
                    if session.canSetSessionPreset(preset) { session.sessionPreset = preset }
                    else if session.canSetSessionPreset(.hd1280x720) { session.sessionPreset = .hd1280x720 }
                    session.commitConfiguration()
                    let dims = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
                    size = (Int(dims.width) & ~1, Int(dims.height) & ~1)
                    session.startRunning()
                    completion(nil)
                } catch {
                    completion(error)
                }
            }
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sample) else { return }
        let w = CVPixelBufferGetWidth(pixelBuffer) & ~1
        let h = CVPixelBufferGetHeight(pixelBuffer) & ~1
        if w > 0, h > 0, (w, h) != size { size = (w, h) }
        onFrame?(pixelBuffer, hostSeconds(CMSampleBufferGetPresentationTimeStamp(sample), session: session))
    }

    func stop() {
        queue.sync { session.stopRunning() }
    }
}

/// Microphone, recorded separately as mono 48 kHz.
final class MicSource: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    let queue = DispatchQueue(label: "zeyvola.mic")
    private let session = AVCaptureSession()
    private(set) var deviceName = ""
    private(set) var level: Float = 0
    var onAudio: ((CMSampleBuffer, Double) -> Void)?

    func prepare(label: String?, completion: @escaping (Error?) -> Void) {
        requestAccess(.audio) { [self] granted in
            guard granted else {
                completion(RecorderError("mic-permission", "Mikrofon izni verilmedi."))
                return
            }
            queue.async { [self] in
                do {
                    let devices = captureDevices(.audio)
                    guard let device = matchDevice(devices, label: label, fallback: AVCaptureDevice.default(for: .audio)) else {
                        throw RecorderError("mic-not-found", "Mikrofon bulunamadı.")
                    }
                    deviceName = device.localizedName
                    session.beginConfiguration()
                    let input = try AVCaptureDeviceInput(device: device)
                    guard session.canAddInput(input) else { throw RecorderError("mic-busy", "Mikrofon açılamadı.") }
                    session.addInput(input)
                    let output = AVCaptureAudioDataOutput()
                    output.audioSettings = [
                        AVFormatIDKey: kAudioFormatLinearPCM,
                        AVSampleRateKey: 48_000,
                        AVNumberOfChannelsKey: 1,
                        AVLinearPCMBitDepthKey: 32,
                        AVLinearPCMIsFloatKey: true,
                        AVLinearPCMIsNonInterleaved: false,
                    ]
                    output.setSampleBufferDelegate(self, queue: queue)
                    guard session.canAddOutput(output) else { throw RecorderError("mic-busy", "Mikrofon açılamadı.") }
                    session.addOutput(output)
                    session.commitConfiguration()
                    session.startRunning()
                    completion(nil)
                } catch {
                    completion(error)
                }
            }
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        level = max(level * 0.85, rmsLevel(sample))
        onAudio?(sample, hostSeconds(CMSampleBufferGetPresentationTimeStamp(sample), session: session))
    }

    func stop() {
        queue.sync { session.stopRunning() }
    }
}

/// 0..1 loudness of a float PCM buffer (for the level meter only).
func rmsLevel(_ sample: CMSampleBuffer) -> Float {
    guard let block = CMSampleBufferGetDataBuffer(sample) else { return 0 }
    var length = 0
    var pointer: UnsafeMutablePointer<CChar>?
    guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == kCMBlockBufferNoErr,
          let p = pointer, length >= 4 else { return 0 }
    let count = length / 4
    return p.withMemoryRebound(to: Float.self, capacity: count) { f in
        var sum: Float = 0
        for k in 0..<count { sum += f[k] * f[k] }
        return min(1, sqrt(sum / Float(count)) * 4)
    }
}
