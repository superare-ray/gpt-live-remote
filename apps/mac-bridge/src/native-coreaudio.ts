import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type CoreAudioStats = {
  sampleRate: number;
  outputChannels: number;
  captureChannels: number;
  outputDeviceName: string;
  outputDeviceUid: string;
  captureDeviceName: string;
  captureDeviceUid: string;
  outputClientAsbd: string;
  outputDeviceAsbd: string;
  captureClientAsbd: string;
  captureDeviceAsbd: string;
  outputNominalRate: number;
  captureNominalRate: number;
  outputAlive: boolean;
  captureAlive: boolean;
  outputCallbacks: number;
  outputFramesAccepted: number;
  outputFramesRendered: number;
  outputFramesUnderrun: number;
  outputFramesOverrun: number;
  captureCallbacks: number;
  captureFramesCaptured: number;
  captureFramesRead: number;
  captureFramesOverrun: number;
  outputPeak: number;
  capturePeak: number;
  outputStatus: number;
  captureStatus: number;
  outputRingFrames: number;
  captureRingFrames: number;
};

type NativeCoreAudioAddon = {
  startOutput(device: string): void;
  startCapture(device: string): void;
  writeOutput(samples: Buffer): number;
  readCapture(maxFrames: number): Buffer;
  stats(): CoreAudioStats;
  stop(): void;
};

const require = createRequire(import.meta.url);
const addonPath = resolve(dirname(fileURLToPath(import.meta.url)), "../build/Release/coreaudio_bridge.node");
const addon = require(addonPath) as NativeCoreAudioAddon;

export class NativeCoreAudioBridge {
  startOutput(device: string) { addon.startOutput(device); }
  startCapture(device: string) { addon.startCapture(device); }
  writeOutput(samples: Buffer) { return addon.writeOutput(samples); }
  readCapture(maxFrames = 4_800) { return addon.readCapture(maxFrames); }
  stats() { return addon.stats(); }
  stop() { addon.stop(); }
}
