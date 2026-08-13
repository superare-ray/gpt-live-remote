#include <AudioUnit/AudioUnit.h>
#include <CoreAudio/CoreAudio.h>
#include <node_api.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

namespace {

constexpr double kSampleRate = 48000.0;
constexpr UInt32 kOutputChannels = 2;
constexpr UInt32 kCaptureChannels = 2;
constexpr size_t kRingCapacityFrames = 48000 * 4;
constexpr UInt32 kMaxCallbackFrames = 8192;

template <typename T>
class SpscRing {
 public:
  explicit SpscRing(size_t capacity) : data_(capacity + 1), capacity_(capacity + 1) {}

  size_t write(const T* source, size_t count) {
    const size_t write = write_.load(std::memory_order_relaxed);
    const size_t read = read_.load(std::memory_order_acquire);
    const size_t used = write >= read ? write - read : capacity_ - read + write;
    const size_t available = capacity_ - 1 - used;
    const size_t accepted = std::min(count, available);
    for (size_t index = 0; index < accepted; ++index) data_[(write + index) % capacity_] = source[index];
    write_.store((write + accepted) % capacity_, std::memory_order_release);
    return accepted;
  }

  size_t read(T* destination, size_t count) {
    const size_t read = read_.load(std::memory_order_relaxed);
    const size_t write = write_.load(std::memory_order_acquire);
    const size_t available = write >= read ? write - read : capacity_ - read + write;
    const size_t consumed = std::min(count, available);
    for (size_t index = 0; index < consumed; ++index) destination[index] = data_[(read + index) % capacity_];
    read_.store((read + consumed) % capacity_, std::memory_order_release);
    return consumed;
  }

  size_t size() const {
    const size_t read = read_.load(std::memory_order_acquire);
    const size_t write = write_.load(std::memory_order_acquire);
    return write >= read ? write - read : capacity_ - read + write;
  }

  void clear() {
    read_.store(0, std::memory_order_release);
    write_.store(0, std::memory_order_release);
  }

 private:
  std::vector<T> data_;
  const size_t capacity_;
  std::atomic<size_t> read_{0};
  std::atomic<size_t> write_{0};
};

std::string fourCC(OSStatus status) {
  char value[5] = {};
  const uint32_t raw = CFSwapInt32HostToBig(static_cast<uint32_t>(status));
  std::memcpy(value, &raw, 4);
  bool printable = true;
  for (int index = 0; index < 4; ++index) printable = printable && value[index] >= 32 && value[index] <= 126;
  return printable ? std::string(value, 4) : std::to_string(status);
}

bool getProperty(AudioObjectID object, AudioObjectPropertySelector selector, AudioObjectPropertyScope scope,
                 void* value, UInt32* size) {
  AudioObjectPropertyAddress address{selector, scope, kAudioObjectPropertyElementMain};
  return AudioObjectGetPropertyData(object, &address, 0, nullptr, size, value) == noErr;
}

std::string stringProperty(AudioObjectID object, AudioObjectPropertySelector selector) {
  CFStringRef value = nullptr;
  UInt32 size = sizeof(value);
  if (!getProperty(object, selector, kAudioObjectPropertyScopeGlobal, &value, &size) || !value) return "";
  char buffer[1024] = {};
  const bool converted = CFStringGetCString(value, buffer, sizeof(buffer), kCFStringEncodingUTF8);
  return converted ? std::string(buffer) : std::string();
}

AudioDeviceID findDevice(const std::string& query) {
  AudioObjectPropertyAddress address{kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal,
                                     kAudioObjectPropertyElementMain};
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, nullptr, &size) != noErr) return 0;
  std::vector<AudioDeviceID> devices(size / sizeof(AudioDeviceID));
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr, &size, devices.data()) != noErr) return 0;
  for (const AudioDeviceID device : devices) {
    if (stringProperty(device, kAudioObjectPropertyName) == query ||
        stringProperty(device, kAudioDevicePropertyDeviceUID) == query) return device;
  }
  return 0;
}

bool deviceAlive(AudioDeviceID device) {
  UInt32 alive = 0;
  UInt32 size = sizeof(alive);
  return device != 0 && getProperty(device, kAudioDevicePropertyDeviceIsAlive,
                                    kAudioObjectPropertyScopeGlobal, &alive, &size) && alive != 0;
}

double nominalRate(AudioDeviceID device) {
  Float64 rate = 0;
  UInt32 size = sizeof(rate);
  getProperty(device, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, &rate, &size);
  return rate;
}

AudioStreamBasicDescription pcmFormat() {
  AudioStreamBasicDescription format{};
  format.mSampleRate = kSampleRate;
  format.mFormatID = kAudioFormatLinearPCM;
  format.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
  format.mBytesPerPacket = sizeof(float) * kOutputChannels;
  format.mFramesPerPacket = 1;
  format.mBytesPerFrame = sizeof(float) * kOutputChannels;
  format.mChannelsPerFrame = kOutputChannels;
  format.mBitsPerChannel = 32;
  return format;
}

std::string asbdDescription(const AudioStreamBasicDescription& format) {
  char formatId[5] = {};
  const uint32_t raw = CFSwapInt32HostToBig(format.mFormatID);
  std::memcpy(formatId, &raw, 4);
  return std::string("format=") + formatId +
      ",rate=" + std::to_string(static_cast<uint64_t>(format.mSampleRate)) +
      ",channels=" + std::to_string(format.mChannelsPerFrame) +
      ",bits=" + std::to_string(format.mBitsPerChannel) +
      ",bytesPerFrame=" + std::to_string(format.mBytesPerFrame) +
      ",framesPerPacket=" + std::to_string(format.mFramesPerPacket) +
      ",flags=" + std::to_string(format.mFormatFlags) +
      ",interleaved=" + ((format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) ? "false" : "true");
}

std::string audioUnitFormat(AudioUnit unit, AudioUnitScope scope, AudioUnitElement element) {
  AudioStreamBasicDescription format{};
  UInt32 size = sizeof(format);
  const OSStatus status = AudioUnitGetProperty(unit, kAudioUnitProperty_StreamFormat, scope, element, &format, &size);
  return status == noErr ? asbdDescription(format) : "unavailable:" + fourCC(status);
}

class CoreAudioBridge {
 public:
  CoreAudioBridge()
      : outputRing_(kRingCapacityFrames), captureRing_(kRingCapacityFrames * kCaptureChannels),
        renderMono_(kMaxCallbackFrames), capturePcm_(kMaxCallbackFrames * kCaptureChannels),
        captureInterleaved_(kMaxCallbackFrames * kCaptureChannels) {}

  ~CoreAudioBridge() { stop(); }

  OSStatus startOutput(const std::string& query) {
    std::lock_guard<std::mutex> lock(lifecycleMutex_);
    if (outputUnit_) return noErr;
    resetStats();
    outputDevice_ = findDevice(query);
    if (!outputDevice_) return kAudioHardwareBadDeviceError;
    outputDeviceName_ = stringProperty(outputDevice_, kAudioObjectPropertyName);
    outputDeviceUid_ = stringProperty(outputDevice_, kAudioDevicePropertyDeviceUID);
    outputNominalRate_ = nominalRate(outputDevice_);

    AudioComponentDescription description{};
    description.componentType = kAudioUnitType_Output;
    description.componentSubType = kAudioUnitSubType_HALOutput;
    description.componentManufacturer = kAudioUnitManufacturer_Apple;
    AudioComponent component = AudioComponentFindNext(nullptr, &description);
    if (!component) return kAudio_ParamError;
    OSStatus status = AudioComponentInstanceNew(component, &outputUnit_);
    if (status != noErr) return rememberOutputStatus(status);

    UInt32 enabled = 1;
    UInt32 disabled = 0;
    status = AudioUnitSetProperty(outputUnit_, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0,
                                  &enabled, sizeof(enabled));
    if (status == noErr) status = AudioUnitSetProperty(outputUnit_, kAudioOutputUnitProperty_EnableIO,
                                                       kAudioUnitScope_Input, 1, &disabled, sizeof(disabled));
    if (status == noErr) status = AudioUnitSetProperty(outputUnit_, kAudioOutputUnitProperty_CurrentDevice,
                                                       kAudioUnitScope_Global, 0, &outputDevice_, sizeof(outputDevice_));
    AudioStreamBasicDescription format = pcmFormat();
    if (status == noErr) status = AudioUnitSetProperty(outputUnit_, kAudioUnitProperty_StreamFormat,
                                                       kAudioUnitScope_Input, 0, &format, sizeof(format));
    AURenderCallbackStruct callback{&CoreAudioBridge::renderCallback, this};
    if (status == noErr) status = AudioUnitSetProperty(outputUnit_, kAudioUnitProperty_SetRenderCallback,
                                                       kAudioUnitScope_Input, 0, &callback, sizeof(callback));
    if (status == noErr) status = AudioUnitInitialize(outputUnit_);
    if (status == noErr) {
      outputClientAsbd_ = audioUnitFormat(outputUnit_, kAudioUnitScope_Input, 0);
      outputDeviceAsbd_ = audioUnitFormat(outputUnit_, kAudioUnitScope_Output, 0);
    }
    if (status == noErr) status = AudioOutputUnitStart(outputUnit_);
    if (status != noErr) {
      rememberOutputStatus(status);
      stopOutputLocked();
    }
    return status;
  }

  OSStatus startCapture(const std::string& query) {
    std::lock_guard<std::mutex> lock(lifecycleMutex_);
    if (captureUnit_) return noErr;
    captureDevice_ = findDevice(query);
    if (!captureDevice_) return kAudioHardwareBadDeviceError;
    captureDeviceName_ = stringProperty(captureDevice_, kAudioObjectPropertyName);
    captureDeviceUid_ = stringProperty(captureDevice_, kAudioDevicePropertyDeviceUID);
    captureNominalRate_ = nominalRate(captureDevice_);

    AudioComponentDescription description{};
    description.componentType = kAudioUnitType_Output;
    description.componentSubType = kAudioUnitSubType_HALOutput;
    description.componentManufacturer = kAudioUnitManufacturer_Apple;
    AudioComponent component = AudioComponentFindNext(nullptr, &description);
    if (!component) return kAudio_ParamError;
    OSStatus status = AudioComponentInstanceNew(component, &captureUnit_);
    if (status != noErr) return rememberCaptureStatus(status);

    UInt32 enabled = 1;
    UInt32 disabled = 0;
    status = AudioUnitSetProperty(captureUnit_, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1,
                                  &enabled, sizeof(enabled));
    if (status == noErr) status = AudioUnitSetProperty(captureUnit_, kAudioOutputUnitProperty_EnableIO,
                                                       kAudioUnitScope_Output, 0, &disabled, sizeof(disabled));
    if (status == noErr) status = AudioUnitSetProperty(captureUnit_, kAudioOutputUnitProperty_CurrentDevice,
                                                       kAudioUnitScope_Global, 0, &captureDevice_, sizeof(captureDevice_));
    AudioStreamBasicDescription format = pcmFormat();
    if (status == noErr) status = AudioUnitSetProperty(captureUnit_, kAudioUnitProperty_StreamFormat,
                                                       kAudioUnitScope_Output, 1, &format, sizeof(format));
    AURenderCallbackStruct callback{&CoreAudioBridge::captureCallback, this};
    if (status == noErr) status = AudioUnitSetProperty(captureUnit_, kAudioOutputUnitProperty_SetInputCallback,
                                                       kAudioUnitScope_Global, 0, &callback, sizeof(callback));
    if (status == noErr) status = AudioUnitInitialize(captureUnit_);
    if (status == noErr) {
      captureClientAsbd_ = audioUnitFormat(captureUnit_, kAudioUnitScope_Output, 1);
      captureDeviceAsbd_ = audioUnitFormat(captureUnit_, kAudioUnitScope_Input, 1);
    }
    if (status == noErr) status = AudioOutputUnitStart(captureUnit_);
    if (status != noErr) {
      rememberCaptureStatus(status);
      stopCaptureLocked();
    }
    return status;
  }

  size_t writeOutput(const int16_t* samples, size_t frames) {
    const size_t accepted = outputRing_.write(samples, frames);
    outputFramesAccepted_.fetch_add(accepted, std::memory_order_relaxed);
    outputFramesOverrun_.fetch_add(frames - accepted, std::memory_order_relaxed);
    return accepted;
  }

  size_t readCapture(int16_t* samples, size_t requestedFrames) {
    const size_t requestedSamples = requestedFrames * kCaptureChannels;
    if (captureRing_.size() < requestedSamples) return 0;
    const size_t consumedSamples = captureRing_.read(samples, requestedSamples);
    const size_t consumedFrames = consumedSamples / kCaptureChannels;
    captureFramesRead_.fetch_add(consumedFrames, std::memory_order_relaxed);
    return consumedFrames;
  }

  void stop() {
    std::lock_guard<std::mutex> lock(lifecycleMutex_);
    stopCaptureLocked();
    stopOutputLocked();
    outputRing_.clear();
    captureRing_.clear();
  }

  struct Snapshot {
    std::string outputName;
    std::string outputUid;
    std::string captureName;
    std::string captureUid;
    std::string outputClientAsbd;
    std::string outputDeviceAsbd;
    std::string captureClientAsbd;
    std::string captureDeviceAsbd;
    double outputNominalRate;
    double captureNominalRate;
    bool outputAlive;
    bool captureAlive;
    uint64_t outputCallbacks;
    uint64_t outputFramesAccepted;
    uint64_t outputFramesRendered;
    uint64_t outputFramesUnderrun;
    uint64_t outputFramesOverrun;
    uint64_t captureCallbacks;
    uint64_t captureFramesCaptured;
    uint64_t captureFramesRead;
    uint64_t captureFramesOverrun;
    uint32_t outputPeak;
    uint32_t capturePeak;
    int32_t outputStatus;
    int32_t captureStatus;
    size_t outputRingFrames;
    size_t captureRingFrames;
  };

  Snapshot snapshot() {
    return {
        outputDeviceName_, outputDeviceUid_, captureDeviceName_, captureDeviceUid_,
        outputClientAsbd_, outputDeviceAsbd_, captureClientAsbd_, captureDeviceAsbd_,
        outputNominalRate_, captureNominalRate_, deviceAlive(outputDevice_), deviceAlive(captureDevice_),
        outputCallbacks_.load(), outputFramesAccepted_.load(), outputFramesRendered_.load(),
        outputFramesUnderrun_.load(), outputFramesOverrun_.load(), captureCallbacks_.load(),
        captureFramesCaptured_.load(), captureFramesRead_.load(), captureFramesOverrun_.load(),
        outputPeak_.exchange(0), capturePeak_.exchange(0), outputStatus_.load(), captureStatus_.load(),
        outputRing_.size(), captureRing_.size() / kCaptureChannels};
  }

 private:
  static OSStatus renderCallback(void* context, AudioUnitRenderActionFlags*, const AudioTimeStamp*,
                                 UInt32, UInt32 frames, AudioBufferList* buffers) {
    return static_cast<CoreAudioBridge*>(context)->render(frames, buffers);
  }

  static OSStatus captureCallback(void* context, AudioUnitRenderActionFlags* flags, const AudioTimeStamp* time,
                                  UInt32, UInt32 frames, AudioBufferList*) {
    return static_cast<CoreAudioBridge*>(context)->capture(flags, time, frames);
  }

  OSStatus render(UInt32 frames, AudioBufferList* buffers) {
    outputCallbacks_.fetch_add(1, std::memory_order_relaxed);
    if (frames > kMaxCallbackFrames || !buffers) return rememberOutputStatus(kAudio_ParamError);
    const size_t consumed = outputRing_.read(renderMono_.data(), frames);
    outputFramesRendered_.fetch_add(consumed, std::memory_order_relaxed);
    outputFramesUnderrun_.fetch_add(frames - consumed, std::memory_order_relaxed);
    uint32_t peak = 0;
    for (size_t index = 0; index < consumed; ++index) peak = std::max(peak, static_cast<uint32_t>(std::abs(static_cast<int>(renderMono_[index]))));
    updatePeak(outputPeak_, peak);

    if (buffers->mNumberBuffers == 1) {
      float* target = static_cast<float*>(buffers->mBuffers[0].mData);
      if (!target) return rememberOutputStatus(kAudio_ParamError);
      for (UInt32 frame = 0; frame < frames; ++frame) {
        const float value = frame < consumed ? static_cast<float>(renderMono_[frame]) / 32768.0f : 0.0f;
        target[frame * 2] = value;
        target[frame * 2 + 1] = value;
      }
    } else {
      for (UInt32 channel = 0; channel < buffers->mNumberBuffers; ++channel) {
        float* target = static_cast<float*>(buffers->mBuffers[channel].mData);
        if (!target) continue;
        for (UInt32 frame = 0; frame < frames; ++frame) {
          target[frame] = frame < consumed ? static_cast<float>(renderMono_[frame]) / 32768.0f : 0.0f;
        }
      }
    }
    return noErr;
  }

  OSStatus capture(AudioUnitRenderActionFlags* flags, const AudioTimeStamp* time, UInt32 frames) {
    captureCallbacks_.fetch_add(1, std::memory_order_relaxed);
    if (frames > kMaxCallbackFrames) return rememberCaptureStatus(kAudio_ParamError);
    AudioBufferList buffers{};
    buffers.mNumberBuffers = 1;
    buffers.mBuffers[0].mNumberChannels = kCaptureChannels;
    buffers.mBuffers[0].mDataByteSize = frames * kCaptureChannels * sizeof(float);
    buffers.mBuffers[0].mData = captureInterleaved_.data();
    const OSStatus status = AudioUnitRender(captureUnit_, flags, time, 1, frames, &buffers);
    if (status != noErr) return rememberCaptureStatus(status);

    uint32_t peak = 0;
    for (UInt32 frame = 0; frame < frames; ++frame) {
      for (UInt32 channel = 0; channel < kCaptureChannels; ++channel) {
        const float value = std::clamp(captureInterleaved_[frame * kCaptureChannels + channel], -1.0f, 1.0f);
        const int16_t sample = static_cast<int16_t>(std::lrint(value * 32767.0f));
        capturePcm_[frame * kCaptureChannels + channel] = sample;
        peak = std::max(peak, static_cast<uint32_t>(std::abs(static_cast<int>(sample))));
      }
    }
    const size_t acceptedSamples = captureRing_.write(capturePcm_.data(), frames * kCaptureChannels);
    const size_t acceptedFrames = acceptedSamples / kCaptureChannels;
    captureFramesCaptured_.fetch_add(acceptedFrames, std::memory_order_relaxed);
    captureFramesOverrun_.fetch_add(frames - acceptedFrames, std::memory_order_relaxed);
    updatePeak(capturePeak_, peak);
    return noErr;
  }

  static void updatePeak(std::atomic<uint32_t>& destination, uint32_t value) {
    uint32_t current = destination.load(std::memory_order_relaxed);
    while (current < value && !destination.compare_exchange_weak(current, value, std::memory_order_relaxed)) {}
  }

  OSStatus rememberOutputStatus(OSStatus status) {
    outputStatus_.store(status, std::memory_order_relaxed);
    return status;
  }

  OSStatus rememberCaptureStatus(OSStatus status) {
    captureStatus_.store(status, std::memory_order_relaxed);
    return status;
  }

  void stopOutputLocked() {
    if (!outputUnit_) return;
    AudioOutputUnitStop(outputUnit_);
    AudioUnitUninitialize(outputUnit_);
    AudioComponentInstanceDispose(outputUnit_);
    outputUnit_ = nullptr;
  }

  void stopCaptureLocked() {
    if (!captureUnit_) return;
    AudioOutputUnitStop(captureUnit_);
    AudioUnitUninitialize(captureUnit_);
    AudioComponentInstanceDispose(captureUnit_);
    captureUnit_ = nullptr;
  }

  void resetStats() {
    outputRing_.clear();
    captureRing_.clear();
    outputCallbacks_.store(0);
    outputFramesAccepted_.store(0);
    outputFramesRendered_.store(0);
    outputFramesUnderrun_.store(0);
    outputFramesOverrun_.store(0);
    captureCallbacks_.store(0);
    captureFramesCaptured_.store(0);
    captureFramesRead_.store(0);
    captureFramesOverrun_.store(0);
    outputPeak_.store(0);
    capturePeak_.store(0);
    outputStatus_.store(noErr);
    captureStatus_.store(noErr);
  }

  std::mutex lifecycleMutex_;
  AudioUnit outputUnit_ = nullptr;
  AudioUnit captureUnit_ = nullptr;
  AudioDeviceID outputDevice_ = 0;
  AudioDeviceID captureDevice_ = 0;
  std::string outputDeviceName_;
  std::string outputDeviceUid_;
  std::string captureDeviceName_;
  std::string captureDeviceUid_;
  std::string outputClientAsbd_;
  std::string outputDeviceAsbd_;
  std::string captureClientAsbd_;
  std::string captureDeviceAsbd_;
  double outputNominalRate_ = 0;
  double captureNominalRate_ = 0;
  SpscRing<int16_t> outputRing_;
  SpscRing<int16_t> captureRing_;
  std::vector<int16_t> renderMono_;
  std::vector<int16_t> capturePcm_;
  std::vector<float> captureInterleaved_;
  std::atomic<uint64_t> outputCallbacks_{0};
  std::atomic<uint64_t> outputFramesAccepted_{0};
  std::atomic<uint64_t> outputFramesRendered_{0};
  std::atomic<uint64_t> outputFramesUnderrun_{0};
  std::atomic<uint64_t> outputFramesOverrun_{0};
  std::atomic<uint64_t> captureCallbacks_{0};
  std::atomic<uint64_t> captureFramesCaptured_{0};
  std::atomic<uint64_t> captureFramesRead_{0};
  std::atomic<uint64_t> captureFramesOverrun_{0};
  std::atomic<uint32_t> outputPeak_{0};
  std::atomic<uint32_t> capturePeak_{0};
  std::atomic<int32_t> outputStatus_{noErr};
  std::atomic<int32_t> captureStatus_{noErr};
};

CoreAudioBridge bridge;

void throwStatus(napi_env env, const char* operation, OSStatus status) {
  const std::string message = std::string(operation) + " failed: " + fourCC(status) + " (" + std::to_string(status) + ")";
  napi_throw_error(env, nullptr, message.c_str());
}

std::string argumentString(napi_env env, napi_value value) {
  size_t length = 0;
  napi_get_value_string_utf8(env, value, nullptr, 0, &length);
  std::string result(length, '\0');
  napi_get_value_string_utf8(env, value, result.data(), result.size() + 1, &length);
  return result;
}

napi_value makeNumber(napi_env env, double value) {
  napi_value result;
  napi_create_double(env, value, &result);
  return result;
}

napi_value makeString(napi_env env, const std::string& value) {
  napi_value result;
  napi_create_string_utf8(env, value.c_str(), value.size(), &result);
  return result;
}

napi_value makeBoolean(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

void set(napi_env env, napi_value object, const char* key, napi_value value) {
  napi_set_named_property(env, object, key, value);
}

napi_value startOutput(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 1) {
    napi_throw_type_error(env, nullptr, "startOutput requires a device name or UID");
    return nullptr;
  }
  const OSStatus status = bridge.startOutput(argumentString(env, args[0]));
  if (status != noErr) {
    throwStatus(env, "CoreAudio output", status);
    return nullptr;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value startCapture(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 1) {
    napi_throw_type_error(env, nullptr, "startCapture requires a device name or UID");
    return nullptr;
  }
  const OSStatus status = bridge.startCapture(argumentString(env, args[0]));
  if (status != noErr) {
    throwStatus(env, "CoreAudio capture", status);
    return nullptr;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value writeOutput(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  void* bytes = nullptr;
  size_t length = 0;
  if (argc != 1 || napi_get_buffer_info(env, args[0], &bytes, &length) != napi_ok || length % sizeof(int16_t) != 0) {
    napi_throw_type_error(env, nullptr, "writeOutput requires an s16le mono Buffer");
    return nullptr;
  }
  const size_t frames = length / sizeof(int16_t);
  return makeNumber(env, static_cast<double>(bridge.writeOutput(static_cast<int16_t*>(bytes), frames)));
}

napi_value readCapture(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  uint32_t maxFrames = 4800;
  if (argc == 1) napi_get_value_uint32(env, args[0], &maxFrames);
  maxFrames = std::min<uint32_t>(maxFrames, 48000);
  std::vector<int16_t> samples(maxFrames * kCaptureChannels);
  const size_t consumed = bridge.readCapture(samples.data(), maxFrames);
  napi_value result;
  void* copied = nullptr;
  napi_create_buffer_copy(env, consumed * kCaptureChannels * sizeof(int16_t), samples.data(), &copied, &result);
  return result;
}

napi_value stats(napi_env env, napi_callback_info) {
  const auto snapshot = bridge.snapshot();
  napi_value result;
  napi_create_object(env, &result);
  set(env, result, "sampleRate", makeNumber(env, kSampleRate));
  set(env, result, "outputChannels", makeNumber(env, 1));
  set(env, result, "captureChannels", makeNumber(env, kCaptureChannels));
  set(env, result, "outputDeviceName", makeString(env, snapshot.outputName));
  set(env, result, "outputDeviceUid", makeString(env, snapshot.outputUid));
  set(env, result, "captureDeviceName", makeString(env, snapshot.captureName));
  set(env, result, "captureDeviceUid", makeString(env, snapshot.captureUid));
  set(env, result, "outputClientAsbd", makeString(env, snapshot.outputClientAsbd));
  set(env, result, "outputDeviceAsbd", makeString(env, snapshot.outputDeviceAsbd));
  set(env, result, "captureClientAsbd", makeString(env, snapshot.captureClientAsbd));
  set(env, result, "captureDeviceAsbd", makeString(env, snapshot.captureDeviceAsbd));
  set(env, result, "outputNominalRate", makeNumber(env, snapshot.outputNominalRate));
  set(env, result, "captureNominalRate", makeNumber(env, snapshot.captureNominalRate));
  set(env, result, "outputAlive", makeBoolean(env, snapshot.outputAlive));
  set(env, result, "captureAlive", makeBoolean(env, snapshot.captureAlive));
  set(env, result, "outputCallbacks", makeNumber(env, snapshot.outputCallbacks));
  set(env, result, "outputFramesAccepted", makeNumber(env, snapshot.outputFramesAccepted));
  set(env, result, "outputFramesRendered", makeNumber(env, snapshot.outputFramesRendered));
  set(env, result, "outputFramesUnderrun", makeNumber(env, snapshot.outputFramesUnderrun));
  set(env, result, "outputFramesOverrun", makeNumber(env, snapshot.outputFramesOverrun));
  set(env, result, "captureCallbacks", makeNumber(env, snapshot.captureCallbacks));
  set(env, result, "captureFramesCaptured", makeNumber(env, snapshot.captureFramesCaptured));
  set(env, result, "captureFramesRead", makeNumber(env, snapshot.captureFramesRead));
  set(env, result, "captureFramesOverrun", makeNumber(env, snapshot.captureFramesOverrun));
  set(env, result, "outputPeak", makeNumber(env, snapshot.outputPeak));
  set(env, result, "capturePeak", makeNumber(env, snapshot.capturePeak));
  set(env, result, "outputStatus", makeNumber(env, snapshot.outputStatus));
  set(env, result, "captureStatus", makeNumber(env, snapshot.captureStatus));
  set(env, result, "outputRingFrames", makeNumber(env, snapshot.outputRingFrames));
  set(env, result, "captureRingFrames", makeNumber(env, snapshot.captureRingFrames));
  return result;
}

napi_value stop(napi_env env, napi_callback_info) {
  bridge.stop();
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

void cleanup(void*) { bridge.stop(); }

napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"startOutput", nullptr, startOutput, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"startCapture", nullptr, startCapture, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"writeOutput", nullptr, writeOutput, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readCapture", nullptr, readCapture, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stats", nullptr, stats, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stop", nullptr, stop, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  napi_add_env_cleanup_hook(env, cleanup, nullptr);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
