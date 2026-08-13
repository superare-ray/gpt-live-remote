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
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";
import { NativeCoreAudioBridge, type CoreAudioStats } from "./native-coreaudio.js";

const execFileAsync = promisify(execFile);
const sampleRate = 48_000;
const upstreamChannels = 1;
const downstreamChannels = 2;
const frameSamples = 480;
const downstreamBitrate = 192_000;
const liveKitQueueMs = 100;

type MediaCredentials = { url: string; token: string; sessionId?: string };
type AudioDefaults = { inputUid: string; outputUid: string; systemOutputUid: string };
type SystemCaptureDevice = {
  deviceName: string;
  deviceUid: string;
  sampleRate: number;
  channels: number;
  excludedPids: number[];
  removedStaleDeviceUids: string[];
};

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function peakDb(peak: number) {
  return peak > 0 ? Number((20 * Math.log10(peak / 32_768)).toFixed(1)) : null;
}

async function stopChild(child: ChildProcessWithoutNullStreams | null) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.destroy();
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(800)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), delay(800)]);
  }
}

export class MacAudioBridge {
  private room: Room | null = null;
  private systemAudioDevice: ChildProcessWithoutNullStreams | null = null;
  private source: AudioSource | null = null;
  private localTrack: LocalAudioTrack | null = null;
  private coreAudio = new NativeCoreAudioBridge();
  private capturePump: Promise<void> | null = null;
  private remoteStream: AudioStream | null = null;
  private remoteTrackSid: string | null = null;
  private closed = false;
  private sessionId = "unassigned";
  private phonePeak = 0;
  private receivedPhoneFrames = 0;
  private publishedReturnFrames = 0;
  private statsTimer: NodeJS.Timeout | null = null;
  private lastOutputAlive: boolean | null = null;
  private lastCaptureAlive: boolean | null = null;
  private lastOutputStatus = 0;
  private lastCaptureStatus = 0;
  private previousDefaults: AudioDefaults | null = null;
  private connectPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly abortController = new AbortController();
  private unexpectedCloseReported = false;

  constructor(private readonly onUnexpectedClose?: (reason: string) => void) {}

  private log(stage: string, fields: Record<string, unknown> = {}) {
    console.log(`[audio][${this.sessionId}][${stage}] ${JSON.stringify(fields)}`);
  }

  private assertOpen() {
    if (this.closed) throw new Error("media_bridge_closed");
  }

  private reportUnexpectedClose(reason: string) {
    if (this.closed || this.unexpectedCloseReported) return;
    this.unexpectedCloseReported = true;
    this.log("pipeline.unexpected-close", { reason });
    void this.close().finally(() => this.onUnexpectedClose?.(reason));
  }

  private async prepareSessionAudioDevices(input: string, localOutput?: string) {
    const script = resolve(dirname(fileURLToPath(import.meta.url)), "../native/audio-device.swift");
    const { stdout } = await execFileAsync("/usr/bin/swift", [script, "get-defaults"]);
    this.assertOpen();
    this.previousDefaults = JSON.parse(stdout) as AudioDefaults;
    await execFileAsync("/usr/bin/swift", [script, "set-input", input]);
    this.assertOpen();
    if (localOutput) await execFileAsync("/usr/bin/swift", [script, "set-output", localOutput]);
    this.assertOpen();
    const { stdout: current } = await execFileAsync("/usr/bin/swift", [script, "get-defaults"]);
    this.log("mac.defaults", { previous: this.previousDefaults, current: JSON.parse(current) });
  }

  private async startSystemAudioDevice(excludedPID: number) {
    const script = resolve(dirname(fileURLToPath(import.meta.url)), "../native/app-audio-device.swift");
    const child = spawn("/usr/bin/swift", [script, String(excludedPID)], { stdio: ["pipe", "pipe", "pipe"] });
    this.systemAudioDevice = child;
    const ready = await new Promise<SystemCaptureDevice>((resolveReady, rejectReady) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectReady(new Error("system_audio_device_timeout"));
      }, 10_000);
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        stdout += chunk.toString();
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        try {
          const result = JSON.parse(stdout.slice(0, newline).trim()) as SystemCaptureDevice;
          settled = true;
          clearTimeout(timeout);
          resolveReady(result);
        } catch (error) {
          settled = true;
          clearTimeout(timeout);
          rejectReady(error);
        }
      });
      child.once("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        rejectReady(new Error(stderr.trim() || `system_audio_device_exited:${code ?? signal}`));
      });
    }).catch(async (error) => {
      await stopChild(child);
      this.systemAudioDevice = null;
      throw error;
    });
    if (ready.sampleRate !== sampleRate || ready.channels !== 2) {
      await stopChild(child);
      this.systemAudioDevice = null;
      throw new Error(`unsupported_system_audio_format:${ready.sampleRate}/${ready.channels}`);
    }
    child.once("exit", (code, signal) => {
      if (this.systemAudioDevice !== child || this.closed) return;
      this.systemAudioDevice = null;
      this.reportUnexpectedClose(`system_audio_device_exited:${code ?? signal ?? "unknown"}`);
    });
    this.log("coreaudio.capture-device.created", ready);
    return ready;
  }

  connect(credentials: MediaCredentials) {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectInternal(credentials);
    return this.connectPromise;
  }

  private async connectInternal(credentials: MediaCredentials) {
    this.sessionId = credentials.sessionId || "unassigned";
    const phoneInputDevice = process.env.PHONE_TO_CHATGPT_DEVICE || "BlackHole 2ch";
    const localPlaybackDevice = process.env.LOCAL_PLAYBACK_DEVICE;
    await this.prepareSessionAudioDevices(phoneInputDevice, localPlaybackDevice);
    this.assertOpen();

    this.coreAudio.startOutput(phoneInputDevice);
    const systemCapture = await this.startSystemAudioDevice(process.pid);
    this.assertOpen();
    this.coreAudio.startCapture(systemCapture.deviceUid);
    const initialStats = this.coreAudio.stats();
    this.log("coreaudio.ready", this.deviceStats(initialStats));
    this.startStatsLogging();
    this.capturePump = this.pumpCapturedAudio();

    let remoteTrackReadySettled = false;
    let remoteTrackReadyResolve: (() => void) | null = null;
    const remoteTrackReady = new Promise<void>((resolveReady, rejectReady) => {
      remoteTrackReadyResolve = () => {
        if (remoteTrackReadySettled) return;
        remoteTrackReadySettled = true;
        resolveReady();
      };
      const abort = () => {
        if (remoteTrackReadySettled) return;
        remoteTrackReadySettled = true;
        rejectReady(new Error("media_bridge_closed"));
      };
      this.abortController.signal.addEventListener("abort", abort, { once: true });
      const room = new Room();
      this.room = room;
      room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        if (track.kind !== TrackKind.KIND_AUDIO) return;
        const previousStream = this.remoteStream;
        const stream = new AudioStream(track, { sampleRate, numChannels: upstreamChannels, frameSizeMs: 10 });
        this.remoteStream = stream;
        this.remoteTrackSid = track.sid || null;
        void previousStream?.cancel().catch(() => null);
        void this.pipeRemoteAudio(stream);
        this.log("webrtc.upstream.subscribed", { participant: participant.identity, trackSid: track.sid });
        remoteTrackReadyResolve?.();
      });
      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind !== TrackKind.KIND_AUDIO || track.sid !== this.remoteTrackSid) return;
        const stream = this.remoteStream;
        this.remoteStream = null;
        this.remoteTrackSid = null;
        void stream?.cancel().catch(() => null);
        this.log("webrtc.upstream.unsubscribed", { trackSid: track.sid });
      });
      room.on(RoomEvent.Disconnected, (reason) => {
        if (!this.closed) this.reportUnexpectedClose(`livekit_disconnected:${String(reason)}`);
      });
    });
    void remoteTrackReady.catch(() => null);

    await this.room!.connect(credentials.url, credentials.token, { autoSubscribe: true, dynacast: false });
    this.assertOpen();
    this.source = new AudioSource(sampleRate, downstreamChannels, liveKitQueueMs);
    this.localTrack = LocalAudioTrack.createAudioTrack("codex-audio", this.source);
    const publishOptions = new TrackPublishOptions({
      source: TrackSource.SOURCE_SCREENSHARE_AUDIO,
      audioEncoding: { maxBitrate: BigInt(downstreamBitrate) },
      dtx: false,
    });
    const publication = await this.room!.localParticipant!.publishTrack(this.localTrack, publishOptions);
    this.log("webrtc.downstream.published", {
      trackSid: publication.sid,
      sampleRate,
      channels: downstreamChannels,
      source: "screenshare_audio",
      maxBitrate: downstreamBitrate,
      dtx: false,
      sourceQueueMs: liveKitQueueMs,
    });
    await Promise.race([
      remoteTrackReady,
      delay(10_000).then(() => { throw new Error("phone_audio_track_timeout"); }),
    ]);
    this.assertOpen();
  }

  private deviceStats(stats: CoreAudioStats) {
    return {
      clientFormat: {
        sampleRate: stats.sampleRate,
        upstreamChannels: stats.outputChannels,
        downstreamChannels: stats.captureChannels,
        sampleFormat: "s16le",
      },
      output: {
        name: stats.outputDeviceName,
        uid: stats.outputDeviceUid,
        nominalRate: stats.outputNominalRate,
        alive: stats.outputAlive,
        clientAsbd: stats.outputClientAsbd,
        deviceAsbd: stats.outputDeviceAsbd,
      },
      capture: {
        name: stats.captureDeviceName,
        uid: stats.captureDeviceUid,
        nominalRate: stats.captureNominalRate,
        alive: stats.captureAlive,
        clientAsbd: stats.captureClientAsbd,
        deviceAsbd: stats.captureDeviceAsbd,
      },
    };
  }

  private startStatsLogging() {
    this.statsTimer = setInterval(() => {
      if (this.closed) return;
      const stats = this.coreAudio.stats();
      this.log("pipeline.stats", {
        upstream: {
          bridgePcmReceived: this.receivedPhoneFrames,
          bridgePeakDb: peakDb(this.phonePeak),
          ringAccepted: stats.outputFramesAccepted,
          ringQueued: stats.outputRingFrames,
          renderCallbacks: stats.outputCallbacks,
          renderedToBlackHole: stats.outputFramesRendered,
          underrun: stats.outputFramesUnderrun,
          overrun: stats.outputFramesOverrun,
          renderPeakDb: peakDb(stats.outputPeak),
          osStatus: stats.outputStatus,
          deviceAlive: stats.outputAlive,
        },
        downstream: {
          captureCallbacks: stats.captureCallbacks,
          capturedFromCoreAudio: stats.captureFramesCaptured,
          capturePeakDb: peakDb(stats.capturePeak),
          ringQueued: stats.captureRingFrames,
          ringRead: stats.captureFramesRead,
          overrun: stats.captureFramesOverrun,
          submittedToLiveKit: this.publishedReturnFrames,
          liveKitQueuedMs: this.source?.queuedDuration ?? 0,
          osStatus: stats.captureStatus,
          deviceAlive: stats.captureAlive,
        },
      });
      this.phonePeak = 0;
      if (this.lastOutputAlive !== null && this.lastOutputAlive !== stats.outputAlive) {
        this.log("coreaudio.output-device.changed", { alive: stats.outputAlive, uid: stats.outputDeviceUid });
      }
      if (this.lastCaptureAlive !== null && this.lastCaptureAlive !== stats.captureAlive) {
        this.log("coreaudio.capture-device.changed", { alive: stats.captureAlive, uid: stats.captureDeviceUid });
      }
      if (stats.outputStatus !== this.lastOutputStatus) {
        this.log("coreaudio.output-status.changed", { osStatus: stats.outputStatus });
      }
      if (stats.captureStatus !== this.lastCaptureStatus) {
        this.log("coreaudio.capture-status.changed", { osStatus: stats.captureStatus });
      }
      this.lastOutputAlive = stats.outputAlive;
      this.lastCaptureAlive = stats.captureAlive;
      this.lastOutputStatus = stats.outputStatus;
      this.lastCaptureStatus = stats.captureStatus;
    }, 2_000);
  }

  private async pipeRemoteAudio(stream: AudioStream) {
    try {
      for await (const frame of stream) {
        if (this.closed || this.remoteStream !== stream) break;
        const samples = frame.data;
        this.receivedPhoneFrames += samples.length;
        for (const sample of samples) this.phonePeak = Math.max(this.phonePeak, Math.abs(sample));
        const bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
        const accepted = this.coreAudio.writeOutput(bytes);
        if (accepted !== samples.length) {
          this.log("coreaudio.output-overrun", { received: samples.length, accepted, dropped: samples.length - accepted });
        }
      }
    } catch (error) {
      if (!this.closed && this.remoteStream === stream) {
        this.log("webrtc.upstream.error", { error: (error as Error).message });
      }
    }
  }

  private async pumpCapturedAudio() {
    while (!this.closed) {
      const chunk = this.coreAudio.readCapture(frameSamples);
      if (!chunk.length) {
        await delay(5);
        continue;
      }
      if (!this.source) {
        await delay(5);
        continue;
      }
      try {
        const samples = new Int16Array(chunk.buffer, chunk.byteOffset, frameSamples * downstreamChannels);
        await this.source.captureFrame(new AudioFrame(samples, sampleRate, downstreamChannels, frameSamples));
        this.publishedReturnFrames += frameSamples;
      } catch (error) {
        if (!this.closed) this.log("webrtc.downstream.error", { error: (error as Error).message });
      }
    }
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.abortController.abort();
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal() {
    this.coreAudio.stop();
    await Promise.all([
      this.room?.disconnect().catch(() => null),
      stopChild(this.systemAudioDevice),
    ]);
    await Promise.race([this.connectPromise?.catch(() => null) || Promise.resolve(), delay(3_000)]);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    const remoteStream = this.remoteStream;
    this.remoteStream = null;
    this.remoteTrackSid = null;
    const systemAudioDevice = this.systemAudioDevice;
    this.systemAudioDevice = null;
    const localTrack = this.localTrack;
    this.localTrack = null;
    const source = this.source;
    this.source = null;
    const room = this.room;
    this.room = null;
    this.coreAudio.stop();
    await remoteStream?.cancel().catch(() => null);
    await stopChild(systemAudioDevice);
    await localTrack?.close().catch(() => null);
    await source?.close().catch(() => null);
    await room?.disconnect().catch(() => null);
    await Promise.race([this.capturePump?.catch(() => null) || Promise.resolve(), delay(500)]);
    this.capturePump = null;
    if (this.previousDefaults) {
      const script = resolve(dirname(fileURLToPath(import.meta.url)), "../native/audio-device.swift");
      const restoreErrors: string[] = [];
      for (const args of [
        ["set-input", this.previousDefaults.inputUid],
        ["set-output", this.previousDefaults.outputUid],
        ["set-system-output", this.previousDefaults.systemOutputUid],
      ]) {
        await execFileAsync("/usr/bin/swift", [script, ...args]).catch((error) => {
          restoreErrors.push((error as Error).message);
        });
      }
      if (restoreErrors.length) this.log("mac.defaults.restore-error", { errors: restoreErrors });
      this.previousDefaults = null;
    }
    this.log("pipeline.closed", {
      bridgePcmReceived: this.receivedPhoneFrames,
      submittedToLiveKit: this.publishedReturnFrames,
    });
  }
}
