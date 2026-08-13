import { readFile } from "node:fs/promises";
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteAudioTrack,
} from "@livekit/rtc-node";
import { desktopVoiceConfigFromEnv, startAndVerifyVoice, stopAndVerifyVoice } from "./desktop-voice.js";
import { MacAudioBridge } from "./media-bridge.js";

const sampleRate = 48_000;
const channels = 1;
const frameSamples = 480;
const frameBytes = frameSamples * Int16Array.BYTES_PER_ELEMENT;

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const url = required("E2E_LIVEKIT_URL");
  const bridgeToken = required("E2E_BRIDGE_TOKEN");
  const phoneToken = required("E2E_PHONE_TOKEN");
  const speechPath = required("E2E_SPEECH_PCM");
  const speech = await readFile(speechPath);
  if (speech.length < frameBytes * 50) throw new Error("test speech is too short");

  const bridge = new MacAudioBridge();
  const phoneRoom = new Room();
  const phoneSource = new AudioSource(sampleRate, channels);
  const phoneTrack = LocalAudioTrack.createAudioTrack("e2e-phone-microphone", phoneSource);
  const voiceConfig = desktopVoiceConfigFromEnv();
  let voiceStarted = false;
  let responseWindowOpen = false;
  let returnPeak = 0;
  let returnActiveFrames = 0;
  let returnFrames = 0;
  let returnTrackReceived = false;

  const returnTrackReady = new Promise<void>((resolve) => {
    phoneRoom.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== TrackKind.KIND_AUDIO || returnTrackReceived) return;
      returnTrackReceived = true;
      const stream = new AudioStream(track as RemoteAudioTrack, {
        sampleRate,
        numChannels: channels,
        frameSizeMs: 10,
      });
      void (async () => {
        for await (const frame of stream) {
          if (!responseWindowOpen) continue;
          returnFrames += 1;
          let framePeak = 0;
          for (const sample of frame.data) framePeak = Math.max(framePeak, Math.abs(sample));
          returnPeak = Math.max(returnPeak, framePeak);
          if (framePeak >= 512) returnActiveFrames += 1;
        }
      })();
      resolve();
    });
  });

  try {
    await phoneRoom.connect(url, phoneToken, { autoSubscribe: true, dynacast: false });
    const publishOptions = new TrackPublishOptions();
    publishOptions.source = TrackSource.SOURCE_MICROPHONE;
    await phoneRoom.localParticipant!.publishTrack(phoneTrack, publishOptions);
    await Promise.all([bridge.connect({ url, token: bridgeToken }), returnTrackReady]);

    const voice = await startAndVerifyVoice(voiceConfig);
    voiceStarted = true;
    console.log(`E2E voice input verified: ${JSON.stringify(voice.audio)}`);
    await delay(1_000);

    // Open on the first request frame, not after the entire utterance. Codex
    // may reply during a pause before a long simulated speech file ends.
    responseWindowOpen = true;
    const startedAt = Date.now();
    for (let offset = 0; offset + frameBytes <= speech.length; offset += frameBytes) {
      const bytes = speech.subarray(offset, offset + frameBytes);
      const samples = new Int16Array(frameSamples);
      samples.set(new Int16Array(bytes.buffer, bytes.byteOffset, frameSamples));
      await phoneSource.captureFrame(new AudioFrame(samples, sampleRate, channels, frameSamples));
      const target = startedAt + ((offset / frameBytes) + 1) * 10;
      const remaining = target - Date.now();
      if (remaining > 0) await delay(remaining);
    }

    // Muting a live browser microphone keeps the media session alive while its
    // playout becomes silence. Explicitly send the equivalent tail here so
    // Codex VAD can observe the end of the simulated utterance.
    const silenceFrame = new AudioFrame(new Int16Array(frameSamples), sampleRate, channels, frameSamples);
    const silenceStartedAt = Date.now();
    const silenceFrames = 250;
    for (let index = 0; index < silenceFrames; index += 1) {
      await phoneSource.captureFrame(silenceFrame);
      const target = silenceStartedAt + (index + 1) * 10;
      const remaining = target - Date.now();
      if (remaining > 0) await delay(remaining);
    }
    const responseDeadline = Date.now() + 45_000;
    while (Date.now() < responseDeadline && (returnPeak < 1_500 || returnActiveFrames < 20)) {
      await delay(250);
    }

    const returnPeakDb = returnPeak > 0 ? 20 * Math.log10(returnPeak / 32_768) : -Infinity;
    const passed = returnTrackReceived && returnPeak >= 1_500 && returnActiveFrames >= 20;
    console.log(JSON.stringify({
      passed,
      speechFrames: Math.floor(speech.length / frameBytes),
      returnTrackReceived,
      returnFrames,
      returnActiveFrames,
      returnPeak,
      returnPeakDb: Number.isFinite(returnPeakDb) ? Number(returnPeakDb.toFixed(1)) : null,
    }));
    if (!passed) throw new Error("No verified Codex return audio reached the simulated frontend");
  } finally {
    responseWindowOpen = false;
    if (voiceStarted) await stopAndVerifyVoice(voiceConfig).catch((error) => console.error(`Voice cleanup failed: ${error.message}`));
    if (phoneTrack.sid) await phoneRoom.localParticipant?.unpublishTrack(phoneTrack.sid, true).catch(() => null);
    await phoneTrack.close().catch(() => null);
    await phoneSource.close().catch(() => null);
    await phoneRoom.disconnect().catch(() => null);
    await bridge.close().catch(() => null);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  },
);
