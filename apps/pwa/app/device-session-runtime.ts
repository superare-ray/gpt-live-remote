import type {
  LocalAudioTrack,
  RemoteAudioTrack,
  RemoteTrackPublication,
  Room,
} from "livekit-client";

export type RuntimeSession = {
  id: string;
  deviceId: string;
  status: "starting" | "ready" | "failed";
  failureReason?: string | null;
  media?: { url: string; token: string } | null;
};

export type RuntimeMediaStatus = "connecting" | "connected" | "failed";
export type RuntimePlaybackStatus = "idle" | "waiting" | "ready" | "blocked" | "error";
export type RuntimeSnapshot = {
  session: RuntimeSession;
  mediaStatus: RuntimeMediaStatus;
  playbackStatus: RuntimePlaybackStatus;
  voiceReady: boolean;
  failure: string | null;
};

type ClientMediaStage =
  | "microphone_published"
  | "ptt_unmute_requested"
  | "ptt_unmuted"
  | "ptt_muted"
  | "rtc_stats"
  | "track_subscribed"
  | "track_unsubscribed"
  | "playback_ready"
  | "playback_blocked"
  | "playback_error";

type RuntimeOptions = {
  session: RuntimeSession;
  microphoneConstraints: MediaTrackConstraints;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  appBasePath: string;
  foreground: boolean;
  outputMuted: boolean;
  onSnapshot: (runtime: DeviceSessionRuntime, snapshot: RuntimeSnapshot) => void;
  onTerminal: (runtime: DeviceSessionRuntime, reason: string) => void;
  onNetworkDisconnected: (runtime: DeviceSessionRuntime) => void;
};

function timeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof window.setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  });
}

export class DeviceSessionRuntime {
  readonly deviceId: string;
  session: RuntimeSession;
  room: Room | null = null;
  micTrack: LocalAudioTrack | null = null;
  remoteTrack: RemoteAudioTrack | null = null;
  remotePublication: RemoteTrackPublication | null = null;
  localAnalyser: AnalyserNode | null = null;
  remoteAnalyser: AnalyserNode | null = null;

  private readonly request: RuntimeOptions["request"];
  private readonly microphoneConstraints: MediaTrackConstraints;
  private readonly appBasePath: string;
  private readonly onSnapshot: RuntimeOptions["onSnapshot"];
  private readonly onTerminal: RuntimeOptions["onTerminal"];
  private readonly onNetworkDisconnected: RuntimeOptions["onNetworkDisconnected"];
  private audioContext: AudioContext | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private localSource: MediaStreamAudioSourceNode | null = null;
  private remoteSource: MediaStreamAudioSourceNode | null = null;
  private controlSocket: WebSocket | null = null;
  private controlHeartbeat: ReturnType<typeof window.setInterval> | null = null;
  private controlReconnectTimer: ReturnType<typeof window.setTimeout> | null = null;
  private statsTimer: ReturnType<typeof window.setInterval> | null = null;
  private statsRunning = false;
  private closing = false;
  private foreground: boolean;
  private outputMuted: boolean;
  private localPublished = false;
  private remoteSubscribed = false;
  private voiceReady = false;
  private mediaStatus: RuntimeMediaStatus = "connecting";
  private playbackStatus: RuntimePlaybackStatus = "idle";
  private failure: string | null = null;

  constructor(options: RuntimeOptions) {
    this.deviceId = options.session.deviceId;
    this.session = options.session;
    this.request = options.request;
    this.microphoneConstraints = options.microphoneConstraints;
    this.appBasePath = options.appBasePath;
    this.foreground = options.foreground;
    this.outputMuted = options.outputMuted;
    this.onSnapshot = options.onSnapshot;
    this.onTerminal = options.onTerminal;
    this.onNetworkDisconnected = options.onNetworkDisconnected;
  }

  snapshot(): RuntimeSnapshot {
    return {
      session: this.session,
      mediaStatus: this.mediaStatus,
      playbackStatus: this.playbackStatus,
      voiceReady: this.voiceReady,
      failure: this.failure,
    };
  }

  private emit() {
    this.onSnapshot(this, this.snapshot());
  }

  private report(stage: ClientMediaStage, detail?: string) {
    if (this.controlSocket?.readyState !== WebSocket.OPEN) return;
    this.controlSocket.send(JSON.stringify({ type: "client.media.status", stage, detail }));
  }

  private updateConnectedState() {
    this.mediaStatus = this.localPublished && this.remoteSubscribed ? "connected" : "connecting";
    this.emit();
  }

  private createAudioElement() {
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    audio.preload = "auto";
    audio.style.display = "none";
    audio.muted = !this.foreground || this.outputMuted;
    audio.volume = 1;
    audio.addEventListener("playing", () => {
      if (!this.foreground || this.closing) return;
      this.playbackStatus = "ready";
      this.report("playback_ready", "audio_element_playing");
      this.emit();
    });
    audio.addEventListener("error", () => {
      if (this.closing) return;
      this.playbackStatus = "error";
      this.report("playback_error", `media_error_${audio.error?.code || "unknown"}`);
      this.emit();
    });
    document.body.appendChild(audio);
    this.audioElement = audio;
  }

  private async openControl(): Promise<void> {
    if (this.controlSocket?.readyState === WebSocket.OPEN) return;
    const url = new URL(`${this.appBasePath}/api/v1/sessions/${this.session.id}/ws`, window.location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.controlSocket = socket;
      let settled = false;
      const connectTimer = window.setTimeout(() => socket.close(4000, "connect timeout"), 6_000);
      socket.onopen = () => {
        window.clearTimeout(connectTimer);
        settled = true;
        if (this.controlHeartbeat) window.clearInterval(this.controlHeartbeat);
        this.controlHeartbeat = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "control.heartbeat" }));
        }, 15_000);
        resolve();
      };
      socket.onerror = () => {
        if (!settled) reject(new Error("控制连接建立失败"));
      };
      socket.onclose = (event) => {
        window.clearTimeout(connectTimer);
        if (this.controlSocket !== socket) return;
        this.controlSocket = null;
        if (this.controlHeartbeat) window.clearInterval(this.controlHeartbeat);
        this.controlHeartbeat = null;
        if (!settled) reject(new Error("控制连接建立失败"));
        if (this.closing) return;
        if (event.code === 4001 || event.code === 1008) {
          this.onTerminal(this, event.reason || "session ended");
          return;
        }
        if (this.controlReconnectTimer) window.clearTimeout(this.controlReconnectTimer);
        this.controlReconnectTimer = window.setTimeout(() => {
          this.controlReconnectTimer = null;
          if (!this.closing) void this.openControl().catch(() => null);
        }, 1_500);
      };
    });
  }

  async connect() {
    if (!this.session.media) throw new Error("媒体服务尚未配置");
    this.mediaStatus = "connecting";
    this.playbackStatus = "waiting";
    this.failure = null;
    this.emit();
    this.createAudioElement();
    const audioContext = new AudioContext({ latencyHint: "interactive" });
    this.audioContext = audioContext;
    await audioContext.resume().catch(() => null);

    const { createLocalAudioTrack, Room, RoomEvent, Track } = await import("livekit-client");
    const localMic = await timeout(createLocalAudioTrack(this.microphoneConstraints), 12_000, "麦克风连接超时");
    if (this.closing) {
      localMic.stop();
      throw new Error("连接已取消");
    }
    await localMic.mute();
    this.micTrack = localMic;
    this.localSource = audioContext.createMediaStreamSource(new MediaStream([localMic.mediaStreamTrack]));
    this.localAnalyser = audioContext.createAnalyser();
    this.localAnalyser.fftSize = 256;
    this.localAnalyser.smoothingTimeConstant = 0.72;
    this.localSource.connect(this.localAnalyser);

    await this.openControl();
    const room = new Room({ adaptiveStream: false, dynacast: false, stopLocalTrackOnUnpublish: false });
    this.room = room;
    room.on(RoomEvent.TrackPublished, (publication) => {
      if (publication.kind !== Track.Kind.Audio || this.closing) return;
      this.remotePublication = publication as RemoteTrackPublication;
      if (this.foreground && !publication.isSubscribed) {
        void (publication as RemoteTrackPublication).setSubscribed(true);
      }
    });
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind !== Track.Kind.Audio || this.closing) return;
      this.remoteTrack = track as RemoteAudioTrack;
      this.remotePublication = publication as RemoteTrackPublication;
      this.remoteSubscribed = true;
      this.report("track_subscribed", `${participant.identity}:${publication.trackSid}`);
      this.remoteSource?.disconnect();
      this.remoteAnalyser?.disconnect();
      try {
        this.remoteSource = audioContext.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
        this.remoteAnalyser = audioContext.createAnalyser();
        this.remoteAnalyser.fftSize = 256;
        this.remoteAnalyser.smoothingTimeConstant = 0.72;
        this.remoteSource.connect(this.remoteAnalyser);
      } catch {
        this.remoteSource = null;
        this.remoteAnalyser = null;
      }
      if (this.foreground) {
        this.attachAndPlay(track as RemoteAudioTrack);
      } else {
        void (publication as RemoteTrackPublication).setSubscribed(false);
      }
      this.updateConnectedState();
    });
    room.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
      if (track.kind !== Track.Kind.Audio) return;
      if (this.remoteTrack === track) this.remoteTrack = null;
      this.remotePublication = publication as RemoteTrackPublication;
      this.remoteSubscribed = false;
      this.report("track_unsubscribed", track.sid);
      track.detach(this.audioElement || undefined);
      if (this.audioElement) {
        this.audioElement.pause();
        this.audioElement.srcObject = null;
      }
      this.remoteSource?.disconnect();
      this.remoteAnalyser?.disconnect();
      this.remoteSource = null;
      this.remoteAnalyser = null;
      this.updateConnectedState();
    });
    room.on(RoomEvent.AudioPlaybackStatusChanged, (canPlay) => {
      if (!this.foreground || this.closing) return;
      this.playbackStatus = canPlay
        ? this.audioElement?.srcObject ? "ready" : "waiting"
        : "blocked";
      this.report(canPlay ? "playback_ready" : "playback_blocked", "livekit_playback_status");
      this.emit();
    });
    room.on(RoomEvent.Disconnected, () => {
      if (this.closing) return;
      this.mediaStatus = "failed";
      this.failure = "媒体连接已断开";
      this.emit();
      this.onNetworkDisconnected(this);
    });

    await timeout(room.connect(this.session.media.url, this.session.media.token, { autoSubscribe: this.foreground }), 12_000, "媒体连接超时");
    await timeout(room.localParticipant.publishTrack(localMic, {
      name: "phone-microphone",
      source: Track.Source.Microphone,
    }), 8_000, "麦克风发布超时");
    this.localPublished = true;
    this.report("microphone_published", JSON.stringify({
      muted: localMic.isMuted,
      enabled: localMic.mediaStreamTrack.enabled,
      readyState: localMic.mediaStreamTrack.readyState,
      sampleRate: localMic.mediaStreamTrack.getSettings().sampleRate,
      channelCount: localMic.mediaStreamTrack.getSettings().channelCount,
    }));
    this.updateConnectedState();
    this.startStats();
    await this.request(`/api/v1/sessions/${this.session.id}/media-ready`, { method: "POST", body: "{}" });
  }

  private attachAndPlay(track: RemoteAudioTrack) {
    const audio = this.audioElement;
    if (!audio) return;
    track.attach(audio);
    audio.muted = !this.foreground || this.outputMuted;
    audio.volume = 1;
    this.playbackStatus = "waiting";
    if (this.outputMuted || !this.foreground) {
      audio.pause();
      this.emit();
      return;
    }
    void Promise.all([this.room?.startAudio(), audio.play()].filter(Boolean) as Promise<unknown>[])
      .then(() => {
        if (!this.foreground || this.closing) return;
        this.playbackStatus = "ready";
        this.report("playback_ready", "foreground_playback_started");
        this.emit();
      })
      .catch((error: Error) => {
        if (!this.foreground || this.closing) return;
        this.playbackStatus = error.name === "NotAllowedError" ? "blocked" : "error";
        this.report(this.playbackStatus === "blocked" ? "playback_blocked" : "playback_error", error.name);
        this.emit();
      });
  }

  private startStats() {
    const report = async () => {
      if (this.statsRunning || this.closing) return;
      this.statsRunning = true;
      try {
        const summarize = (stats: RTCStatsReport | undefined, direction: "outbound-rtp" | "inbound-rtp") => {
          let result: Record<string, unknown> | null = null;
          stats?.forEach((entry) => {
            if (entry.type !== direction || entry.kind !== "audio") return;
            result = direction === "outbound-rtp"
              ? { bytes: entry.bytesSent, packets: entry.packetsSent, retransmitted: entry.retransmittedPacketsSent }
              : { bytes: entry.bytesReceived, packets: entry.packetsReceived, lost: entry.packetsLost, jitter: entry.jitter };
          });
          return result;
        };
        const [outbound, inbound] = await Promise.all([
          this.micTrack?.getRTCStatsReport(),
          this.remoteTrack?.getRTCStatsReport(),
        ]);
        this.report("rtc_stats", JSON.stringify({
          foreground: this.foreground,
          microphone: this.micTrack ? {
            muted: this.micTrack.isMuted,
            enabled: this.micTrack.mediaStreamTrack.enabled,
            readyState: this.micTrack.mediaStreamTrack.readyState,
          } : null,
          outbound: summarize(outbound, "outbound-rtp"),
          inbound: summarize(inbound, "inbound-rtp"),
          playback: this.audioElement ? {
            paused: this.audioElement.paused,
            readyState: this.audioElement.readyState,
            muted: this.audioElement.muted,
          } : null,
        }));
      } finally {
        this.statsRunning = false;
      }
    };
    void report();
    this.statsTimer = window.setInterval(() => void report(), 2_000);
  }

  updateSession(session: RuntimeSession, voiceReady = session.status === "ready") {
    this.session = session;
    this.voiceReady = voiceReady;
    this.emit();
  }

  setVoiceReady(ready: boolean) {
    this.voiceReady = ready;
    this.emit();
  }

  async setForeground(foreground: boolean) {
    this.foreground = foreground;
    if (!foreground) {
      await this.micTrack?.mute().catch(() => null);
      if (this.remotePublication) await this.remotePublication.setSubscribed(false).catch(() => null);
      if (this.audioElement) {
        this.audioElement.muted = true;
        this.audioElement.pause();
      }
      this.emit();
      return;
    }
    if (this.remotePublication && !this.remotePublication.isSubscribed) {
      await this.remotePublication.setSubscribed(true).catch(() => null);
    } else if (this.remoteTrack) {
      this.attachAndPlay(this.remoteTrack);
    }
    await this.resumePlayback();
    this.emit();
  }

  setOutputMuted(muted: boolean) {
    this.outputMuted = muted;
    if (this.audioElement) {
      this.audioElement.muted = muted || !this.foreground;
      if (muted) this.audioElement.pause();
    }
    if (!muted && this.foreground) void this.resumePlayback();
    this.emit();
  }

  async resumePlayback() {
    const operations: Promise<unknown>[] = [];
    if (this.audioContext) operations.push(this.audioContext.resume());
    if (this.room) operations.push(this.room.startAudio());
    if (this.audioElement?.srcObject && !this.outputMuted && this.foreground) {
      this.audioElement.muted = this.outputMuted || !this.foreground;
      this.audioElement.volume = 1;
      operations.push(this.audioElement.play());
    }
    await Promise.all(operations);
  }

  async startTalking() {
    if (!this.foreground || this.mediaStatus !== "connected" || this.session.status !== "ready" || !this.micTrack) return false;
    const track = this.micTrack;
    this.report("ptt_unmute_requested", JSON.stringify({
      muted: track.isMuted,
      enabled: track.mediaStreamTrack.enabled,
      readyState: track.mediaStreamTrack.readyState,
    }));
    await track.unmute();
    this.report("ptt_unmuted", JSON.stringify({
      muted: track.isMuted,
      enabled: track.mediaStreamTrack.enabled,
      readyState: track.mediaStreamTrack.readyState,
    }));
    return true;
  }

  async stopTalking() {
    const track = this.micTrack;
    if (!track) return;
    await track.mute().catch(() => null);
    this.report("ptt_muted", JSON.stringify({
      muted: track.isMuted,
      enabled: track.mediaStreamTrack.enabled,
      readyState: track.mediaStreamTrack.readyState,
    }));
  }

  fail(message: string) {
    this.mediaStatus = "failed";
    this.failure = message;
    this.emit();
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    if (this.controlReconnectTimer) window.clearTimeout(this.controlReconnectTimer);
    if (this.controlHeartbeat) window.clearInterval(this.controlHeartbeat);
    if (this.statsTimer) window.clearInterval(this.statsTimer);
    this.controlReconnectTimer = null;
    this.controlHeartbeat = null;
    this.statsTimer = null;
    const socket = this.controlSocket;
    this.controlSocket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "runtime closed");
    await this.micTrack?.mute().catch(() => null);
    if (this.room && this.micTrack) await this.room.localParticipant.unpublishTrack(this.micTrack, false).catch(() => null);
    await this.room?.disconnect().catch(() => null);
    this.micTrack?.stop();
    this.localSource?.disconnect();
    this.remoteSource?.disconnect();
    this.localAnalyser?.disconnect();
    this.remoteAnalyser?.disconnect();
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.srcObject = null;
      this.audioElement.remove();
    }
    if (this.audioContext && this.audioContext.state !== "closed") await this.audioContext.close().catch(() => null);
    this.room = null;
    this.micTrack = null;
    this.remoteTrack = null;
    this.remotePublication = null;
    this.localSource = null;
    this.remoteSource = null;
    this.localAnalyser = null;
    this.remoteAnalyser = null;
    this.audioElement = null;
    this.audioContext = null;
  }
}
