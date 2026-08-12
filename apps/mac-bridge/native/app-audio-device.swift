import CoreAudio
import Foundation

enum AppAudioDeviceError: Error, CustomStringConvertible {
    case noMatchingProcess([String])
    case unableToCreateTap
    case unableToCreateAggregateDevice
    case usage

    var description: String {
        switch self {
        case .noMatchingProcess(let bundleIDs):
            return "No active CoreAudio process found for: \(bundleIDs.joined(separator: ", "))"
        case .unableToCreateTap:
            return "Unable to create the CoreAudio process tap"
        case .unableToCreateAggregateDevice:
            return "Unable to create the CoreAudio aggregate device"
        case .usage:
            return "Usage: app-audio-device <bundle-id> [bundle-id ...]"
        }
    }
}

@available(macOS 26.0, *)
final class AppAudioDevice {
    private let system = AudioHardwareSystem.shared
    private var tap: AudioHardwareTap?
    private var aggregateDevice: AudioHardwareAggregateDevice?
    private var stopped = false

    func start(bundleIDs: [String]) throws {
        let matchingProcesses = try system.processes.filter { process in
            guard let bundleID = try process.bundleID else { return false }
            return bundleIDs.contains(bundleID)
        }
        guard !matchingProcesses.isEmpty else {
            throw AppAudioDeviceError.noMatchingProcess(bundleIDs)
        }

        let description = CATapDescription(monoMixdownOfProcesses: matchingProcesses.map(\.id))
        description.name = "GPT-Live Codex Audio"
        description.isPrivate = false
        description.muteBehavior = .unmuted
        description.isProcessRestoreEnabled = true

        guard let tap = try system.makeProcessTap(description: description) else {
            throw AppAudioDeviceError.unableToCreateTap
        }
        self.tap = tap

        let deviceName = "GPT-Live Codex Capture"
        let deviceUID = "com.gpt-live-remote.codex-capture.\(UUID().uuidString)"
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
            "processIds": matchingProcesses.map { Int(try! $0.pid) },
            "sampleRate": tapFormat.mSampleRate,
            "channels": tapFormat.mChannelsPerFrame,
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

let bundleIDs = Array(CommandLine.arguments.dropFirst())
guard !bundleIDs.isEmpty else {
    FileHandle.standardError.write(Data("\(AppAudioDeviceError.usage)\n".utf8))
    exit(1)
}

let device = AppAudioDevice()
do {
    try device.start(bundleIDs: bundleIDs)
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
