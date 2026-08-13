import CoreAudio
import Foundation

private let captureDeviceUIDPrefix = "com.gpt-live-remote.system-capture."

private func stringProperty(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var value: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    let status = withUnsafeMutablePointer(to: &value) { pointer in
        AudioObjectGetPropertyData(object, &address, 0, nil, &size, pointer)
    }
    return status == noErr ? value as String : nil
}

private func removeStaleCaptureDevices() -> [String] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else {
        return []
    }
    var devices = Array(repeating: AudioDeviceID(0), count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &devices) == noErr else {
        return []
    }
    var removed: [String] = []
    for device in devices {
        guard let uid = stringProperty(device, kAudioDevicePropertyDeviceUID), uid.hasPrefix(captureDeviceUIDPrefix) else {
            continue
        }
        if AudioHardwareDestroyAggregateDevice(device) == noErr { removed.append(uid) }
    }
    return removed
}

enum AppAudioDeviceError: Error, CustomStringConvertible {
    case excludedProcessUnavailable([pid_t])
    case unableToCreateTap
    case unableToCreateAggregateDevice

    var description: String {
        switch self {
        case .excludedProcessUnavailable(let pids):
            return "CoreAudio did not register excluded process PID(s): \(pids.map(String.init).joined(separator: ", "))"
        case .unableToCreateTap:
            return "Unable to create the CoreAudio process tap"
        case .unableToCreateAggregateDevice:
            return "Unable to create the CoreAudio aggregate device"
        }
    }
}

@available(macOS 26.0, *)
final class AppAudioDevice {
    private let system = AudioHardwareSystem.shared
    private var tap: AudioHardwareTap?
    private var aggregateDevice: AudioHardwareAggregateDevice?
    private var stopped = false

    func start(excludedPIDs: Set<pid_t>) throws {
        let removedStaleDeviceUIDs = removeStaleCaptureDevices()
        var excludedProcesses: [AudioHardwareProcess] = []
        var foundPIDs = Set<pid_t>()
        for _ in 0..<50 {
            excludedProcesses = try system.processes.filter { process in
                excludedPIDs.contains(try process.pid)
            }
            foundPIDs = Set(try excludedProcesses.map { try $0.pid })
            if excludedPIDs.isSubset(of: foundPIDs) { break }
            Thread.sleep(forTimeInterval: 0.05)
        }
        let missingPIDs = excludedPIDs.subtracting(foundPIDs)
        guard missingPIDs.isEmpty else {
            throw AppAudioDeviceError.excludedProcessUnavailable(Array(missingPIDs).sorted())
        }
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: excludedProcesses.map(\.id))
        description.name = "GPT-Live System Audio"
        description.isPrivate = false
        // The browser is the active network headset. Once the Bridge reads
        // this tap, keep the captured signal off the Mac hardware output so
        // the same sound is not played both locally and remotely.
        description.muteBehavior = .mutedWhenTapped
        description.isProcessRestoreEnabled = true

        guard let tap = try system.makeProcessTap(description: description) else {
            throw AppAudioDeviceError.unableToCreateTap
        }
        self.tap = tap

        let deviceName = "GPT-Live System Capture"
        let deviceUID = "\(captureDeviceUIDPrefix)\(UUID().uuidString)"
        let aggregateDescription: [String: Any] = [
            kAudioAggregateDeviceNameKey: deviceName,
            kAudioAggregateDeviceUIDKey: deviceUID,
            kAudioAggregateDeviceIsPrivateKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
        ]
        guard let aggregateDevice = try system.makeAggregateDevice(description: aggregateDescription) else {
            throw AppAudioDeviceError.unableToCreateAggregateDevice
        }
        self.aggregateDevice = aggregateDevice
        try aggregateDevice.setSubtaps([tap])

        let tapFormat = try tap.format
        let result: [String: Any] = [
            "deviceName": deviceName,
            "deviceUid": deviceUID,
            "sampleRate": tapFormat.mSampleRate,
            "channels": tapFormat.mChannelsPerFrame,
            "excludedPids": foundPIDs.map(Int.init).sorted(),
            "removedStaleDeviceUids": removedStaleDeviceUIDs,
        ]
        let data = try JSONSerialization.data(withJSONObject: result, options: [])
        print(String(decoding: data, as: UTF8.self))
        fflush(stdout)
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        if let aggregateDevice {
            try? system.destroyAggregateDevice(aggregateDevice)
        }
        if let tap {
            try? system.destroyProcessTap(tap)
        }
        self.aggregateDevice = nil
        self.tap = nil
    }

    deinit {
        stop()
    }
}

guard #available(macOS 26.0, *) else {
    FileHandle.standardError.write(Data("Application audio capture requires macOS 26 or later\n".utf8))
    exit(1)
}

let device = AppAudioDevice()
do {
    let excludedPIDs = Set(CommandLine.arguments.dropFirst().compactMap { pid_t($0) })
    try device.start(excludedPIDs: excludedPIDs)
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}

signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let signalQueue = DispatchQueue(label: "com.gpt-live-remote.audio-device-signals")
let interruptSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: signalQueue)
let terminateSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: signalQueue)
for source in [interruptSource, terminateSource] {
    source.setEventHandler {
        device.stop()
        exit(0)
    }
    source.resume()
}
dispatchMain()
