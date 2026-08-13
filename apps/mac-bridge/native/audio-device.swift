import CoreAudio
import CoreGraphics
import Foundation

enum AudioDeviceError: Error, CustomStringConvertible {
    case property(OSStatus)
    case deviceNotFound(String)
    case usage

    var description: String {
        switch self {
        case .property(let status): return "CoreAudio error \(status)"
        case .deviceNotFound(let name): return "Audio device not found: \(name)"
        case .usage: return "Usage: audio-device get-defaults | process-io <bundle-id> | send-hotkey <key> <comma-separated-modifiers> | set-input <name-or-uid> | set-output <name-or-uid> | set-system-output <name-or-uid>"
        }
    }
}

func keyboardKeyCode(_ key: String) throws -> CGKeyCode {
    let keyCodes: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
        "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
        "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22,
        "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
        "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37,
        "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
        "n": 45, "m": 46, ".": 47, "space": 49,
    ]
    guard let code = keyCodes[key.lowercased()] else { throw AudioDeviceError.usage }
    return code
}

func sendHotkey(key: String, modifiers: String) throws {
    var flags: CGEventFlags = []
    for modifier in modifiers.split(separator: ",").map({ $0.trimmingCharacters(in: .whitespaces).lowercased() }) {
        switch modifier {
        case "command": flags.insert(.maskCommand)
        case "control": flags.insert(.maskControl)
        case "option": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        case "": continue
        default: throw AudioDeviceError.usage
        }
    }
    let code = try keyboardKeyCode(key)
    guard
        let source = CGEventSource(stateID: .hidSystemState),
        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
    else { throw AudioDeviceError.usage }
    keyDown.flags = flags
    keyUp.flags = flags
    keyDown.post(tap: .cghidEventTap)
    usleep(80_000)
    keyUp.post(tap: .cghidEventTap)
}

func defaultDevice(_ selector: AudioObjectPropertySelector) throws -> AudioDeviceID {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &value)
    guard status == noErr else { throw AudioDeviceError.property(status) }
    return value
}

func stringProperty(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> String {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    let status = withUnsafeMutablePointer(to: &value) { pointer in
        AudioObjectGetPropertyData(object, &address, 0, nil, &size, pointer)
    }
    guard status == noErr else { throw AudioDeviceError.property(status) }
    return value as String
}

func devices() throws -> [AudioDeviceID] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size)
    guard status == noErr else { throw AudioDeviceError.property(status) }
    var values = Array(repeating: AudioDeviceID(0), count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &values)
    guard status == noErr else { throw AudioDeviceError.property(status) }
    return values
}

func findDevice(_ query: String) throws -> AudioDeviceID {
    for device in try devices() {
        let name = try stringProperty(device, kAudioObjectPropertyName)
        let uid = try stringProperty(device, kAudioDevicePropertyDeviceUID)
        if name == query || uid == query { return device }
    }
    throw AudioDeviceError.deviceNotFound(query)
}

func setDefault(_ selector: AudioObjectPropertySelector, _ device: AudioDeviceID) throws {
    var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value = device
    let status = AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, UInt32(MemoryLayout<AudioDeviceID>.size), &value)
    guard status == noErr else { throw AudioDeviceError.property(status) }
}

do {
    guard CommandLine.arguments.count >= 2 else { throw AudioDeviceError.usage }
    switch CommandLine.arguments[1] {
    case "get-defaults", "get-input":
        let input = try defaultDevice(kAudioHardwarePropertyDefaultInputDevice)
        let output = try defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)
        let systemOutput = try defaultDevice(kAudioHardwarePropertyDefaultSystemOutputDevice)
        let result = [
            "inputUid": try stringProperty(input, kAudioDevicePropertyDeviceUID),
            "outputUid": try stringProperty(output, kAudioDevicePropertyDeviceUID),
            "systemOutputUid": try stringProperty(systemOutput, kAudioDevicePropertyDeviceUID),
        ]
        let data = try JSONSerialization.data(withJSONObject: result, options: [])
        print(String(decoding: data, as: UTF8.self))
    case "process-io":
        guard CommandLine.arguments.count == 3 else { throw AudioDeviceError.usage }
        guard #available(macOS 26.0, *) else {
            throw AudioDeviceError.usage
        }
        let targetBundleID = CommandLine.arguments[2]
        let matching = try AudioHardwareSystem.shared.processes.filter { process in
            guard let bundleID = try process.bundleID else { return false }
            return bundleID == targetBundleID || bundleID.hasPrefix(targetBundleID + ".")
        }
        let result: [String: Any] = [
            "input": try matching.contains { try $0.isRunningInput },
            "output": try matching.contains { try $0.isRunningOutput },
            "pids": try matching.map { Int(try $0.pid) }.sorted(),
        ]
        let data = try JSONSerialization.data(withJSONObject: result, options: [])
        print(String(decoding: data, as: UTF8.self))
    case "send-hotkey":
        guard CommandLine.arguments.count == 4 else { throw AudioDeviceError.usage }
        try sendHotkey(key: CommandLine.arguments[2], modifiers: CommandLine.arguments[3])
        print("ok")
    case "set-input":
        guard CommandLine.arguments.count == 3 else { throw AudioDeviceError.usage }
        try setDefault(kAudioHardwarePropertyDefaultInputDevice, findDevice(CommandLine.arguments[2]))
        print("ok")
    case "set-output":
        guard CommandLine.arguments.count == 3 else { throw AudioDeviceError.usage }
        let device = try findDevice(CommandLine.arguments[2])
        try setDefault(kAudioHardwarePropertyDefaultOutputDevice, device)
        try setDefault(kAudioHardwarePropertyDefaultSystemOutputDevice, device)
        print("ok")
    case "set-system-output":
        guard CommandLine.arguments.count == 3 else { throw AudioDeviceError.usage }
        try setDefault(kAudioHardwarePropertyDefaultSystemOutputDevice, findDevice(CommandLine.arguments[2]))
        print("ok")
    default:
        throw AudioDeviceError.usage
    }
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
