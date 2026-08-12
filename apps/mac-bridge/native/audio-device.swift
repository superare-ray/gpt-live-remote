import CoreAudio
import Foundation

enum AudioDeviceError: Error, CustomStringConvertible {
    case property(OSStatus)
    case deviceNotFound(String)
    case usage

    var description: String {
        switch self {
        case .property(let status): return "CoreAudio error \(status)"
        case .deviceNotFound(let name): return "Audio device not found: \(name)"
        case .usage: return "Usage: audio-device get-defaults | set-defaults <input name-or-uid> <output name-or-uid>"
        }
    }
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
    case "get-defaults":
        let input = try defaultDevice(kAudioHardwarePropertyDefaultInputDevice)
        let output = try defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)
        let result = [
            "inputUid": try stringProperty(input, kAudioDevicePropertyDeviceUID),
            "outputUid": try stringProperty(output, kAudioDevicePropertyDeviceUID),
        ]
        let data = try JSONSerialization.data(withJSONObject: result, options: [])
        print(String(decoding: data, as: UTF8.self))
    case "set-defaults":
        guard CommandLine.arguments.count == 4 else { throw AudioDeviceError.usage }
        try setDefault(kAudioHardwarePropertyDefaultInputDevice, findDevice(CommandLine.arguments[2]))
        try setDefault(kAudioHardwarePropertyDefaultOutputDevice, findDevice(CommandLine.arguments[3]))
        print("ok")
    default:
        throw AudioDeviceError.usage
    }
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
