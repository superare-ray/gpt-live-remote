import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  Track,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";

const execFileAsync = promisify(execFile);
const sampleRate = 48_000;
const channels = 1;
const frameSamples = 480;
const frameBytes = frameSamples * Int16Array.BYTES_PER_ELEMENT;

type MediaCredentials = { url: string; token: string };

async function avFoundationAudioIndex(ffmpegPath: string, deviceName: string) {
  const result = await execFileAsync(ffmpegPath, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], {
    maxBuffer: 1024 * 1024,
  }).catch((error: unknown) => error as { stderr?: string });
  const output = "stderr" in result ? result.stderr || "" : "";
  const audioSection = output.split("AVFoundation audio devices:")[1] || "";
  for (const line of audioSection.split("\n")) {
    const match = line.match(/\[(\d+)]\s+(.+)$/);
    if (match?.[2]?.trim() === deviceName) return Number(match[1]);
  }
  throw new Error(`audio_device_not_found:${deviceName}`);
}

async function audioToolboxOutputIndex(ffmpegPath: string, deviceName: string) {
  const result = await execFileAsync(ffmpegPath, [
    "-hide_banner", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "0.01",
    "-list_devices", "true", "-f", "audiotoolbox", "-",
  ], { maxBuffer: 1024 * 1024 }).catch((error: unknown) => error as { stderr?: string });
  const output = "stderr" in result ? result.stderr || "" : "";
  for (const line of output.split("\n")) {
    const match = line.match(/\[(\d+)]\s+(.+?),\s+\S+$/);
    if (match?.[2]?.trim() === deviceName) return Number(match[1]);
  }
  throw new Error(`audio_output_device_not_found:${deviceName}`);
}

function waitForExit(child: ChildProcessWithoutNullStreams, label: string) {
  child.once("exit", (code, signal) => {
    if (code && signal !== "SIGTERM") console.error(`${label} exited (${code})`);
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams | null) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.destroy();
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise<void>((resolve) => setTimeout(resolve, 800)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      once(child, "exit"),
      new Promise<void>((resolve) => setTimeout(resolve, 800)),
    ]);
  }
}

export class MacAudioBridge {
  private room: Room | null = null;
  private playout: ChildProcessWithoutNullStreams | null = null;
  private capture: ChildProcessWithoutNullStreams | null = null;
  private source: AudioSource | null = null;
  private localTrack: LocalAudioTrack | null = null;
  private captureQueue = Promise.resolve();
  private pendingCapture = Buffer.alloc(0);
  private remoteStream: AudioStream | null = null;
  private remoteTrackSid: string | null = null;
  private closed = false;
  private phonePeak = 0;
  private lastPhoneActivityAt = 0;
  private replyPeak = 0;
  private lastReplyActivityAt = 0;
  private previousDefaults: { inputUid: string; outputUid: string } | null = null;

  private async setSessionAudioDefaults(input: string, output: string) {
    const script = resolve(dirname(fileURLToPath(import.meta.url)), "../native/audio-device.swift");
    const { stdout } = await execFileAsync("/usr/bin/swift", [script, "get-defaults"]);
    this.previousDefaults = JSON.parse(stdout) as { inputUid: string; outputUid: string };
    await execFileAsync("/usr/bin/swift", [script, "set-defaults", input, output]);
  }

  async connect(credentials: MediaCredentials) {
    const ffmpegPath = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
    const phoneToChatGptDevice = process.env.PHONE_TO_CHATGPT_DEVICE || "BlackHole 2ch";
    const chatGptToPhoneDevice = process.env.CHATGPT_TO_PHONE_DEVICE || "BlackHole 16ch";
    const [playoutIndex, captureIndex] = await Promise.all([
      audioToolboxOutputIndex(ffmpegPath, phoneToChatGptDevice),
      avFoundationAudioIndex(ffmpegPath, chatGptToPhoneDevice),
    ]);
    await this.setSessionAudioDefaults(phoneToChatGptDevice, chatGptToPhoneDevice);

    this.playout = spawn(ffmpegPath, [
      "-hide_banner", "-loglevel", "error",
      "-f", "s16le", "-ar", String(sampleRate), "-ac", String(channels), "-i", "pipe:0",
      "-audio_device_index", String(playoutIndex), "-f", "audiotoolbox", "-",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    waitForExit(this.playout, "BlackHole playout");

    const remoteTrackReady = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("phone_audio_track_timeout")), 10_000);
      const room = new Room();
      this.room = room;
      room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        if (track.kind !== TrackKind.KIND_AUDIO) return;
        clearTimeout(timeout);
        const previousStream = this.remoteStream;
        const stream = new AudioStream(track, { sampleRate, numChannels: channels, frameSizeMs: 10 });
        this.remoteStream = stream;
        this.remoteTrackSid = track.sid || null;
        void previousStream?.cancel().catch(() => null);
        void this.pipeRemoteAudio(stream);
        console.log(`✓ 手机音轨已接入 (${participant.identity})`);
        resolve();
      });
      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind !== TrackKind.KIND_AUDIO || track.sid !== this.remoteTrackSid) return;
        const stream = this.remoteStream;
        this.remoteStream = null;
        this.remoteTrackSid = null;
        void stream?.cancel().catch(() => null);
        console.log("◌ 手机音轨已断开，等待重连");
      });
    });

    await this.room!.connect(credentials.url, credentials.token, { autoSubscribe: true, dynacast: false });
    this.source = new AudioSource(sampleRate, channels);
    this.localTrack = LocalAudioTrack.createAudioTrack("chatgpt-audio", this.source);
    const publishOptions = new TrackPublishOptions();
    publishOptions.source = TrackSource.SOURCE_MICROPHONE;
    await this.room!.localParticipant!.publishTrack(this.localTrack, publishOptions);

    this.capture = spawn(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-thread_queue_size", "512",
      "-f", "avfoundation", "-i", `:${captureIndex}`,
      "-af", "pan=mono|c0=c0+c1+c2+c3+c4+c5+c6+c7+c8+c9+c10+c11+c12+c13+c14+c15",
      "-ac", String(channels), "-ar", String(sampleRate), "-f", "s16le", "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    waitForExit(this.capture, "BlackHole capture");
    this.capture.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString().trim();
      if (message && !this.closed) console.error(`BlackHole capture: ${message}`);
    });
    this.capture.stdout.on("data", (chunk: Buffer) => this.enqueueCapturedAudio(chunk));
    await remoteTrackReady;
  }

  private async pipeRemoteAudio(stream: AudioStream) {
    const writer = this.playout?.stdin;
    if (!writer) return;
    try {
      for await (const frame of stream) {
        if (this.closed || this.remoteStream !== stream) break;
        const samples = frame.data;
        for (const sample of samples) this.phonePeak = Math.max(this.phonePeak, Math.abs(sample));
        const now = Date.now();
        if (this.phonePeak >= 256 && now - this.lastPhoneActivityAt >= 1_000) {
          const peakDb = (20 * Math.log10(this.phonePeak / 32_768)).toFixed(1);
          console.log(`🎙 手机上行音频活动：峰值 ${peakDb} dBFS`);
          this.phonePeak = 0;
          this.lastPhoneActivityAt = now;
        } else if (now - this.lastPhoneActivityAt >= 1_000) {
          this.phonePeak = 0;
        }
        const bytes = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
        if (!writer.write(bytes)) await once(writer, "drain");
      }
    } catch (error) {
      if (!this.closed && this.remoteStream === stream) console.error(`Remote audio playout failed: ${(error as Error).message}`);
    }
  }

  private enqueueCapturedAudio(chunk: Buffer) {
    const capturedSamples = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / Int16Array.BYTES_PER_ELEMENT));
    for (const sample of capturedSamples) this.replyPeak = Math.max(this.replyPeak, Math.abs(sample));
    const now = Date.now();
    if (this.replyPeak >= 256 && now - this.lastReplyActivityAt >= 1_000) {
      const peakDb = (20 * Math.log10(this.replyPeak / 32_768)).toFixed(1);
      console.log(`🔊 GPT 回传音频活动：峰值 ${peakDb} dBFS`);
      this.replyPeak = 0;
      this.lastReplyActivityAt = now;
    } else if (now - this.lastReplyActivityAt >= 1_000) {
      this.replyPeak = 0;
    }
    this.pendingCapture = Buffer.concat([this.pendingCapture, chunk]);
    const frames: Buffer[] = [];
    while (this.pendingCapture.length >= frameBytes) {
      frames.push(Buffer.from(this.pendingCapture.subarray(0, frameBytes)));
      this.pendingCapture = this.pendingCapture.subarray(frameBytes);
    }
    if (!frames.length) return;
    this.captureQueue = this.captureQueue.then(async () => {
      for (const bytes of frames) {
        if (this.closed || !this.source) return;
        const samples = new Int16Array(frameSamples);
        samples.set(new Int16Array(bytes.buffer, bytes.byteOffset, frameSamples));
        await this.source.captureFrame(new AudioFrame(samples, sampleRate, channels, frameSamples));
      }
    }).catch((error) => {
      if (!this.closed) console.error(`Captured audio publish failed: ${(error as Error).message}`);
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.remoteStream?.cancel().catch(() => null);
    this.remoteStream = null;
    this.remoteTrackSid = null;
    await Promise.all([stopChild(this.playout), stopChild(this.capture)]);
    this.playout = null;
    this.capture = null;
    await this.localTrack?.close().catch(() => null);
    await this.source?.close().catch(() => null);
    await this.room?.disconnect();
    if (this.previousDefaults) {
      const script = resolve(dirname(fileURLToPath(import.meta.url)), "../native/audio-device.swift");
      await execFileAsync("/usr/bin/swift", [script, "set-defaults", this.previousDefaults.inputUid, this.previousDefaults.outputUid]).catch((error) => {
        console.error(`Unable to restore Mac audio defaults: ${(error as Error).message}`);
      });
      this.previousDefaults = null;
    }
  }
}
