"use client";

import {
  ArrowLeft,
  Check,
  ChevronDown,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  Mic,
  Monitor,
  QrCode,
  RefreshCw,
  Server,
  Square,
  Volume2,
  VolumeX,
  Waves,
} from "lucide-react";
import { FormEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";
import type { LocalAudioTrack, RemoteAudioTrack, Room } from "livekit-client";

type AuthUser = { id: string; email: string };
type Device = {
  id: string;
  name: string;
  kind: "macbook" | "macmini";
  status: "online" | "offline";
  lastSeen: string | null;
};
type RemoteSession = {
  id: string;
  deviceId: string;
  status: "starting" | "ready" | "failed";
  failureReason?: string | null;
  media?: { url: string; token: string } | null;
};
type WaveLevels = [number, number, number];
type AudioPlaybackStatus = "idle" | "waiting" | "ready" | "blocked" | "error";
type MicrophoneRecovery = { device: Device; message: string };
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
const appBasePath = process.env.NEXT_PUBLIC_APP_BASE_PATH ?? "";
const microphoneConstraints: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};
const sessionFailureMessages: Record<string, string> = {
  voice_shortcut_not_configured: "Mac 尚未配置 Voice 快捷键",
  voice_shortcut_modifiers_invalid: "Mac 的 Voice 快捷键配置无效",
  voice_state_probe_not_configured: "Mac 尚未完成 Voice 状态标定",
  voice_state_probe_pattern_invalid: "Mac 的 Voice 状态标定无效",
  chatgpt_app_not_found: "Mac 上未找到支持 Voice 的 ChatGPT Desktop",
  accessibility_permission_missing: "Mac Bridge 缺少辅助功能权限",
  voice_ui_state_unverified: "已触发快捷键，但未确认 Voice 界面启动",
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${appBasePath}${path}`, {
      cache: "no-store",
      ...init,
      credentials: "include",
      headers: { "content-type": "application/json", ...(init?.headers || {}) },
      signal: init?.signal ?? controller.signal,
    });
    const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || "请求失败，请稍后重试");
    return payload;
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new Error("连接超时，请重试");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof window.setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}

function DeviceIcon({ kind }: { kind: Device["kind"] }) {
  return kind === "macmini" ? <Square aria-hidden /> : <Laptop aria-hidden />;
}

function isMicrophoneAccessError(error: unknown) {
  const candidate = error as { name?: string; message?: string };
  return candidate.name === "NotAllowedError"
    || candidate.name === "SecurityError"
    || /麦克风连接超时|permission|denied|not allowed/i.test(candidate.message || "");
}

export default function Home() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [loginStep, setLoginStep] = useState<"email" | "code">("email");
  const [devices, setDevices] = useState<Device[]>([]);
  const [pairCode, setPairCode] = useState("");
  const [pairing, setPairing] = useState(false);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [activeDevice, setActiveDevice] = useState<Device | null>(null);
  const [remoteSession, setRemoteSession] = useState<RemoteSession | null>(null);
  const [showDeviceManager, setShowDeviceManager] = useState(false);
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const [microphoneRecovery, setMicrophoneRecovery] = useState<MicrophoneRecovery | null>(null);
  const [requestingMicrophone, setRequestingMicrophone] = useState(false);
  const [audioOutputMuted, setAudioOutputMuted] = useState(false);
  const [talking, setTalking] = useState(false);
  const [replying, setReplying] = useState(false);
  const [mediaStatus, setMediaStatus] = useState<"idle" | "connecting" | "connected">("idle");
  const [audioPlaybackStatus, setAudioPlaybackStatus] = useState<AudioPlaybackStatus>("idle");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const roomRef = useRef<Room | null>(null);
  const micTrackRef = useRef<LocalAudioTrack | null>(null);
  const remoteAudioTrackRef = useRef<RemoteAudioTrack | null>(null);
  const remoteAudioElementRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const localAudioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const remoteAudioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const localAnalyserRef = useRef<AnalyserNode | null>(null);
  const remoteAnalyserRef = useRef<AnalyserNode | null>(null);
  const talkingRef = useRef(false);
  const activePointerRef = useRef<number | null>(null);
  const remotePlaybackAllowedRef = useRef(false);
  const audioOutputMutedRef = useRef(false);
  const controlSocketRef = useRef<WebSocket | null>(null);
  const controlSessionRef = useRef<string | null>(null);
  const controlHeartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const controlReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mediaStatsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mediaStatsRunningRef = useRef(false);
  const voiceControlsRef = useRef<HTMLDivElement | null>(null);
  const deviceMenuRef = useRef<HTMLDivElement | null>(null);
  const intentionalSessionEndRef = useRef<string | null>(null);
  const mediaConnectionAttemptRef = useRef(0);
  const [waveLevels, setWaveLevels] = useState<WaveLevels>([0, 0, 0]);

  const reportClientMedia = useCallback((stage: ClientMediaStage, detail?: string) => {
    const socket = controlSocketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "client.media.status", stage, detail }));
  }, []);

  const closeSessionControl = useCallback(() => {
    controlSessionRef.current = null;
    if (controlReconnectTimerRef.current) clearTimeout(controlReconnectTimerRef.current);
    controlReconnectTimerRef.current = null;
    if (controlHeartbeatRef.current) clearInterval(controlHeartbeatRef.current);
    controlHeartbeatRef.current = null;
    const socket = controlSocketRef.current;
    controlSocketRef.current = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "session closed");
  }, []);

  const closeAudioGraph = useCallback(async () => {
    localAudioSourceRef.current?.disconnect();
    remoteAudioSourceRef.current?.disconnect();
    localAnalyserRef.current?.disconnect();
    remoteAnalyserRef.current?.disconnect();
    localAudioSourceRef.current = null;
    remoteAudioSourceRef.current = null;
    localAnalyserRef.current = null;
    remoteAnalyserRef.current = null;
    const audioElement = remoteAudioElementRef.current;
    if (audioElement) {
      audioElement.pause();
      audioElement.srcObject = null;
    }
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== "closed") await context.close().catch(() => null);
    setWaveLevels([0, 0, 0]);
  }, []);

  const disconnectMedia = useCallback(async () => {
    mediaConnectionAttemptRef.current += 1;
    remotePlaybackAllowedRef.current = false;
    activePointerRef.current = null;
    setMediaStatus("idle");
    setAudioPlaybackStatus("idle");
    setReplying(false);
    talkingRef.current = false;
    setTalking(false);
    const track = micTrackRef.current;
    micTrackRef.current = null;
    const room = roomRef.current;
    roomRef.current = null;
    remoteAudioTrackRef.current = null;
    if (mediaStatsTimerRef.current) clearInterval(mediaStatsTimerRef.current);
    mediaStatsTimerRef.current = null;
    if (track) await track.mute().catch(() => null);
    if (room && track) await room.localParticipant.unpublishTrack(track, false).catch(() => null);
    if (room) await room.disconnect().catch(() => null);
    if (track) track.stop();
    closeSessionControl();
    await closeAudioGraph();
  }, [closeAudioGraph, closeSessionControl]);

  const loadDevices = useCallback(async () => {
    const result = await request<{ devices: Device[] }>("/api/v1/devices");
    setDevices(result.devices);
    return result.devices;
  }, []);

  useEffect(() => {
    const audioElement = document.createElement("audio");
    audioElement.autoplay = true;
    audioElement.playsInline = true;
    audioElement.preload = "auto";
    audioElement.style.display = "none";
    const handlePlaying = () => {
      if (!remotePlaybackAllowedRef.current) return;
      setAudioPlaybackStatus("ready");
      reportClientMedia("playback_ready", "audio_element_playing");
    };
    const handleError = () => {
      setAudioPlaybackStatus("error");
      reportClientMedia("playback_error", `media_error_${audioElement.error?.code || "unknown"}`);
    };
    audioElement.addEventListener("playing", handlePlaying);
    audioElement.addEventListener("error", handleError);
    document.body.appendChild(audioElement);
    remoteAudioElementRef.current = audioElement;
    return () => {
      if (remoteAudioElementRef.current === audioElement) remoteAudioElementRef.current = null;
      audioElement.pause();
      audioElement.srcObject = null;
      audioElement.removeEventListener("playing", handlePlaying);
      audioElement.removeEventListener("error", handleError);
      audioElement.remove();
    };
  }, [reportClientMedia]);

  useEffect(() => {
    const isInsideVoiceControls = (node: Node | null) => Boolean(node && voiceControlsRef.current?.contains(node));
    const preventVoiceSelection = (event: Event) => {
      if (!isInsideVoiceControls(event.target as Node | null)) return;
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
    };
    const clearVoiceSelection = () => {
      const selection = window.getSelection();
      if (isInsideVoiceControls(selection?.anchorNode ?? null) || isInsideVoiceControls(selection?.focusNode ?? null)) {
        selection?.removeAllRanges();
      }
    };
    document.addEventListener("selectstart", preventVoiceSelection, true);
    document.addEventListener("contextmenu", preventVoiceSelection, true);
    document.addEventListener("dragstart", preventVoiceSelection, true);
    document.addEventListener("selectionchange", clearVoiceSelection);
    return () => {
      document.removeEventListener("selectstart", preventVoiceSelection, true);
      document.removeEventListener("contextmenu", preventVoiceSelection, true);
      document.removeEventListener("dragstart", preventVoiceSelection, true);
      document.removeEventListener("selectionchange", clearVoiceSelection);
    };
  }, []);

  useEffect(() => {
    if (!deviceMenuOpen) return;
    const closeOnOutsidePress = (event: globalThis.PointerEvent) => {
      if (!deviceMenuRef.current?.contains(event.target as Node)) setDeviceMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDeviceMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [deviceMenuOpen]);

  useEffect(() => {
    if (!activeDevice || !remoteSession) return;
    let animationFrame = 0;
    let lastUpdate = 0;
    let smoothed: WaveLevels = [0, 0, 0];
    const samples = new Uint8Array(256);

    const measure = (analyser: AnalyserNode | null): WaveLevels => {
      if (!analyser) return [0, 0, 0];
      analyser.getByteTimeDomainData(samples);
      const segmentLength = Math.floor(samples.length / 3);
      return [0, 1, 2].map((segment) => {
        let energy = 0;
        const start = segment * segmentLength;
        const end = segment === 2 ? samples.length : start + segmentLength;
        for (let index = start; index < end; index += 1) {
          const normalized = (samples[index] - 128) / 128;
          energy += normalized * normalized;
        }
        const rms = Math.sqrt(energy / (end - start));
        return Math.min(1, Math.max(0, (rms - 0.008) / 0.22));
      }) as WaveLevels;
    };

    const renderMeter = (time: number) => {
      if (time - lastUpdate >= 45) {
        const local = measure(localAnalyserRef.current);
        const remote = measure(remoteAnalyserRef.current);
        const remoteActive = Math.max(...remote) > 0.05;
        const measured = remoteActive ? remote : local;
        setReplying(remoteActive);
        smoothed = smoothed.map((value, index) => value * 0.58 + measured[index] * 0.42) as WaveLevels;
        setWaveLevels(smoothed);
        lastUpdate = time;
      }
      animationFrame = requestAnimationFrame(renderMeter);
    };

    animationFrame = requestAnimationFrame(renderMeter);
    return () => cancelAnimationFrame(animationFrame);
  }, [activeDevice, remoteSession]);

  function openSessionControl(sessionId: string): Promise<void> {
    const current = controlSocketRef.current;
    if (controlSessionRef.current === sessionId && current?.readyState === WebSocket.OPEN) return Promise.resolve();
    controlSessionRef.current = sessionId;

    return new Promise((resolve, reject) => {
      const url = new URL(`${appBasePath}/api/v1/sessions/${sessionId}/ws`, window.location.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      controlSocketRef.current = socket;
      let settled = false;
      const connectTimeout = window.setTimeout(() => socket.close(4000, "connect timeout"), 6_000);

      socket.onopen = () => {
        window.clearTimeout(connectTimeout);
        settled = true;
        if (controlHeartbeatRef.current) clearInterval(controlHeartbeatRef.current);
        controlHeartbeatRef.current = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "control.heartbeat" }));
        }, 15_000);
        resolve();
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as {
            type?: string;
            error?: string;
          };
          if (message.type === "control.error" && message.error === "bridge_offline") setNotice("Mac Bridge 已离线");
        } catch {
          // Ignore unknown status messages; the socket remains usable.
        }
      };
      socket.onerror = () => {
        if (!settled) reject(new Error("控制连接建立失败"));
      };
      socket.onclose = (event) => {
        window.clearTimeout(connectTimeout);
        const isCurrentSocket = controlSocketRef.current === socket;
        if (isCurrentSocket) {
          controlSocketRef.current = null;
          if (controlHeartbeatRef.current) clearInterval(controlHeartbeatRef.current);
          controlHeartbeatRef.current = null;
        }
        if (!settled) reject(new Error("控制连接建立失败"));
        if (!isCurrentSocket || controlSessionRef.current !== sessionId || !roomRef.current) return;
        if (event.code === 4001 || event.code === 1008) {
          controlSessionRef.current = null;
          void disconnectMedia().finally(() => {
            setConnectingId(null);
            setRemoteSession(null);
            setActiveDevice(null);
            setShowDeviceManager(true);
            if (intentionalSessionEndRef.current !== sessionId) setNotice("连接已断开，请重新连接设备");
            void loadDevices();
          });
          return;
        }
        setNotice("控制连接正在恢复");
        if (controlReconnectTimerRef.current) clearTimeout(controlReconnectTimerRef.current);
        controlReconnectTimerRef.current = window.setTimeout(() => {
          controlReconnectTimerRef.current = null;
          if (controlSessionRef.current !== sessionId || !roomRef.current) return;
          void openSessionControl(sessionId).then(() => setNotice(null)).catch(() => null);
        }, 1_500);
      };
    });
  }

  async function sendLoginCode(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    try {
      await request("/api/v1/auth/email/start", { method: "POST", body: JSON.stringify({ email }) });
      setLoginStep("code");
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function verifyLogin(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    try {
      const result = await request<{ user: AuthUser }>("/api/v1/auth/email/verify", {
        method: "POST",
        body: JSON.stringify({ email, code }),
      });
      setUser(result.user);
      await loadDevices();
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function pairDevice(event: FormEvent) {
    event.preventDefault();
    setPairing(true);
    setNotice(null);
    try {
      await request("/api/v1/pairing/exchange", {
        method: "POST",
        body: JSON.stringify({ code: pairCode.trim().toUpperCase() }),
      });
      setPairCode("");
      await loadDevices();
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setPairing(false);
    }
  }

  async function stopCurrentSession(propagateError = false, preserveLiveView = false) {
    if (!remoteSession || disconnecting) return;
    const endingSessionId = remoteSession.id;
    intentionalSessionEndRef.current = endingSessionId;
    setDisconnecting(true);
    setDeviceMenuOpen(false);
    setNotice(null);
    let stopError: Error | null = null;
    try {
      await request(`/api/v1/sessions/${endingSessionId}/stop`, { method: "POST", body: "{}" });
    } catch (error) {
      stopError = error as Error;
    } finally {
      await disconnectMedia();
      talkingRef.current = false;
      setTalking(false);
      if (!preserveLiveView) {
        setRemoteSession(null);
        setActiveDevice(null);
        setShowDeviceManager(true);
      }
      await loadDevices().catch(() => null);
      setDisconnecting(false);
      if (intentionalSessionEndRef.current === endingSessionId) intentionalSessionEndRef.current = null;
    }
    if (stopError) {
      setNotice(stopError.message);
      if (propagateError) throw stopError;
    }
  }

  async function joinSessionMedia(session: RemoteSession) {
    if (!session.media) throw new Error("媒体服务尚未配置");
    await disconnectMedia();
    const attempt = ++mediaConnectionAttemptRef.current;
    const ensureCurrentAttempt = () => {
      if (mediaConnectionAttemptRef.current !== attempt) throw new Error("连接已取消");
    };
    setMediaStatus("connecting");
    setAudioPlaybackStatus("waiting");

    try {
      remotePlaybackAllowedRef.current = false;
      const audioContext = new AudioContext({ latencyHint: "interactive" });
      audioContextRef.current = audioContext;
      await audioContext.resume().catch(() => null);
      ensureCurrentAttempt();
      const { createLocalAudioTrack, Room, RoomEvent, Track } = await import("livekit-client");
      const localMic = await withTimeout(createLocalAudioTrack(microphoneConstraints).then((track) => {
          if (mediaConnectionAttemptRef.current !== attempt) {
            track.stop();
            throw new Error("连接已取消");
          }
          return track;
        }), 12_000, "麦克风连接超时");
      ensureCurrentAttempt();
      await localMic.mute();
      micTrackRef.current = localMic;
      const localSource = audioContext.createMediaStreamSource(new MediaStream([localMic.mediaStreamTrack]));
      const localAnalyser = audioContext.createAnalyser();
      localAnalyser.fftSize = 256;
      localAnalyser.smoothingTimeConstant = 0.72;
      localSource.connect(localAnalyser);
      localAudioSourceRef.current = localSource;
      localAnalyserRef.current = localAnalyser;

      await openSessionControl(session.id);
      ensureCurrentAttempt();
      const room = new Room({ adaptiveStream: false, dynacast: false, stopLocalTrackOnUnpublish: false });
      roomRef.current = room;
      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind !== Track.Kind.Audio) return;
        remoteAudioTrackRef.current = track as RemoteAudioTrack;
        setAudioPlaybackStatus("waiting");
        reportClientMedia("track_subscribed", `${participant.identity}:${publication.trackSid}`);
        const audioElement = remoteAudioElementRef.current;
        if (audioElement) {
          track.attach(audioElement);
          audioElement.muted = !remotePlaybackAllowedRef.current || audioOutputMutedRef.current;
          audioElement.volume = 1;
          void room.startAudio()
            .then(() => audioElement.play())
            .then(() => {
              if (!remotePlaybackAllowedRef.current) return;
              setAudioPlaybackStatus("ready");
              reportClientMedia("playback_ready", "track_autoplay_started");
            })
            .catch((error: Error) => {
              const blocked = error.name === "NotAllowedError";
              setAudioPlaybackStatus(blocked ? "blocked" : "error");
              reportClientMedia(blocked ? "playback_blocked" : "playback_error", error.name || "track_autoplay_failed");
            });
        }
        remoteAudioSourceRef.current?.disconnect();
        remoteAnalyserRef.current?.disconnect();
        try {
          const remoteSource = audioContext.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
          const remoteAnalyser = audioContext.createAnalyser();
          remoteAnalyser.fftSize = 256;
          remoteAnalyser.smoothingTimeConstant = 0.72;
          remoteSource.connect(remoteAnalyser);
          remoteAudioSourceRef.current = remoteSource;
          remoteAnalyserRef.current = remoteAnalyser;
        } catch {
          remoteAudioSourceRef.current = null;
          remoteAnalyserRef.current = null;
        }
      });
      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        if (track.kind !== Track.Kind.Audio) return;
        if (remoteAudioTrackRef.current === track) remoteAudioTrackRef.current = null;
        setAudioPlaybackStatus("waiting");
        reportClientMedia("track_unsubscribed", track.sid);
        const audioElement = remoteAudioElementRef.current;
        if (audioElement) {
          track.detach(audioElement);
          audioElement.pause();
          audioElement.srcObject = null;
        }
        remoteAudioSourceRef.current?.disconnect();
        remoteAnalyserRef.current?.disconnect();
        remoteAudioSourceRef.current = null;
        remoteAnalyserRef.current = null;
      });
      room.on(RoomEvent.AudioPlaybackStatusChanged, (canPlay) => {
        if (roomRef.current !== room) return;
        if (!remotePlaybackAllowedRef.current) {
          setAudioPlaybackStatus("waiting");
          return;
        }
        reportClientMedia(canPlay ? "playback_ready" : "playback_blocked", "livekit_playback_status");
        setAudioPlaybackStatus(canPlay
          ? remoteAudioElementRef.current?.srcObject ? "ready" : "waiting"
          : "blocked");
      });
      room.on(RoomEvent.Disconnected, () => {
        if (roomRef.current !== room) return;
        void disconnectMedia().finally(() => {
          setNotice("媒体连接已断开，请重新连接设备");
        });
      });
      await withTimeout(room.connect(session.media.url, session.media.token, { autoSubscribe: true }), 12_000, "媒体连接超时");
      ensureCurrentAttempt();
      await withTimeout(room.localParticipant.publishTrack(localMic, {
        name: "phone-microphone",
        source: Track.Source.Microphone,
      }), 8_000, "麦克风发布超时");
      reportClientMedia("microphone_published", JSON.stringify({
        muted: localMic.isMuted,
        enabled: localMic.mediaStreamTrack.enabled,
        readyState: localMic.mediaStreamTrack.readyState,
        sampleRate: localMic.mediaStreamTrack.getSettings().sampleRate,
        channelCount: localMic.mediaStreamTrack.getSettings().channelCount,
      }));
      const reportRtcStats = async () => {
        if (mediaStatsRunningRef.current || roomRef.current !== room) return;
        mediaStatsRunningRef.current = true;
        try {
          const summarize = (report: RTCStatsReport | undefined, direction: "outbound-rtp" | "inbound-rtp") => {
            let result: Record<string, unknown> | null = null;
            report?.forEach((entry) => {
              if (entry.type !== direction || entry.kind !== "audio") return;
              result = direction === "outbound-rtp"
                ? { bytes: entry.bytesSent, packets: entry.packetsSent, retransmitted: entry.retransmittedPacketsSent }
                : { bytes: entry.bytesReceived, packets: entry.packetsReceived, lost: entry.packetsLost, jitter: entry.jitter };
            });
            return result;
          };
          const [outbound, inbound] = await Promise.all([
            localMic.getRTCStatsReport(),
            remoteAudioTrackRef.current?.getRTCStatsReport(),
          ]);
          reportClientMedia("rtc_stats", JSON.stringify({
            microphone: {
              muted: localMic.isMuted,
              enabled: localMic.mediaStreamTrack.enabled,
              readyState: localMic.mediaStreamTrack.readyState,
            },
            outbound: summarize(outbound, "outbound-rtp"),
            inbound: summarize(inbound, "inbound-rtp"),
            playback: {
              paused: remoteAudioElementRef.current?.paused,
              readyState: remoteAudioElementRef.current?.readyState,
              muted: remoteAudioElementRef.current?.muted,
            },
          }));
        } finally {
          mediaStatsRunningRef.current = false;
        }
      };
      await reportRtcStats();
      mediaStatsTimerRef.current = window.setInterval(() => void reportRtcStats(), 2_000);
      ensureCurrentAttempt();
      await request(`/api/v1/sessions/${session.id}/media-ready`, { method: "POST", body: "{}" });
      ensureCurrentAttempt();
      talkingRef.current = false;
      setTalking(false);
      setMediaStatus("connected");
    } catch (error) {
      if (mediaConnectionAttemptRef.current === attempt) await disconnectMedia();
      throw error;
    }
  }

  async function waitForSessionReady(sessionId: string) {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const latest = await request<{ session: RemoteSession }>(`/api/v1/sessions/${sessionId}`);
      if (latest.session.status === "ready") return latest.session;
      if (latest.session.status === "failed") {
        throw new Error(sessionFailureMessages[latest.session.failureReason || ""] || "连接失败，请检查 Mac Bridge 的诊断信息");
      }
      await new Promise((resolve) => window.setTimeout(resolve, 750));
    }
    throw new Error("连接超时，请重新连接设备");
  }

  async function activateSession(session: RemoteSession, device: Device) {
    setConnectingId(device.id);
    setRemoteSession(session);
    setActiveDevice(device);
    setShowDeviceManager(false);
    await joinSessionMedia(session);
    const readySession = session.status === "ready" ? session : await waitForSessionReady(session.id);
    setRemoteSession(readySession);
    setActiveDevice(device);
    setShowDeviceManager(false);
    setConnectingId(null);
    remotePlaybackAllowedRef.current = true;
    resumeRemoteAudio();
  }

  async function connectDevice(device: Device) {
    if (remoteSession?.deviceId === device.id && mediaStatus === "connected") {
      setDeviceMenuOpen(false);
      setShowDeviceManager(false);
      return;
    }
    unlockRemoteAudioFromGesture();
    setDeviceMenuOpen(false);
    setConnectingId(device.id);
    setNotice(null);
    setMicrophoneRecovery(null);
    let createdSession: RemoteSession | null = null;
    if (remoteSession) {
      try {
        await stopCurrentSession(true, true);
      } catch {
        setConnectingId(null);
        return;
      }
    }
    try {
      const result = await request<{ session: RemoteSession }>("/api/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ deviceId: device.id }),
      });
      createdSession = result.session;
      intentionalSessionEndRef.current = null;
      await activateSession(result.session, device);
    } catch (error) {
      if (createdSession) {
        await request(`/api/v1/sessions/${createdSession.id}/stop`, { method: "POST", body: "{}" }).catch(() => null);
      }
      setConnectingId(null);
      await disconnectMedia();
      setRemoteSession(null);
      setActiveDevice(null);
      setShowDeviceManager(true);
      if (isMicrophoneAccessError(error)) {
        setMicrophoneRecovery({
          device,
          message: "需要麦克风权限才能连接。请重新授权后继续。",
        });
        setNotice(null);
      } else {
        setNotice((error as Error).message);
      }
    }
  }

  async function retryMicrophonePermission() {
    if (!microphoneRecovery || requestingMicrophone) return;
    const recovery = microphoneRecovery;
    setRequestingMicrophone(true);
    let permissionAttemptExpired = false;
    try {
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints }).then((candidate) => {
          if (permissionAttemptExpired) {
            candidate.getTracks().forEach((track) => track.stop());
            throw new Error("麦克风授权等待超时");
          }
          return candidate;
        }),
        15_000,
        "麦克风授权等待超时",
      );
      stream.getTracks().forEach((track) => track.stop());
      setMicrophoneRecovery(null);
      await connectDevice(recovery.device);
    } catch (error) {
      setMicrophoneRecovery({
        device: recovery.device,
        message: (error as Error).name === "NotAllowedError"
          ? "麦克风仍未授权。请在当前网站权限中允许麦克风后再试。"
          : "未能获得麦克风权限，请确认网站权限后重试。",
      });
    } finally {
      permissionAttemptExpired = true;
      setRequestingMicrophone(false);
    }
  }

  function resumeRemoteAudio() {
    const room = roomRef.current;
    const audioElement = remoteAudioElementRef.current;
    const operations: Promise<unknown>[] = [];
    if (audioContextRef.current) operations.push(audioContextRef.current.resume());
    if (room) operations.push(room.startAudio());
    if (audioElement?.srcObject) {
      audioElement.muted = !remotePlaybackAllowedRef.current || audioOutputMutedRef.current;
      audioElement.volume = 1;
      operations.push(audioElement.play());
    }
    void Promise.all(operations).then(() => {
      if (audioElement?.srcObject) {
        if (!remotePlaybackAllowedRef.current) {
          setAudioPlaybackStatus("waiting");
          return;
        }
        setAudioPlaybackStatus("ready");
        reportClientMedia("playback_ready", "user_gesture_resume");
      } else if (room) {
        setAudioPlaybackStatus("waiting");
      }
    }).catch((error: Error) => {
      const blocked = error.name === "NotAllowedError";
      setAudioPlaybackStatus(blocked ? "blocked" : "error");
      reportClientMedia(blocked ? "playback_blocked" : "playback_error", error.name || "user_gesture_resume_failed");
    });
  }

  function toggleAudioOutputMute() {
    const muted = !audioOutputMutedRef.current;
    audioOutputMutedRef.current = muted;
    setAudioOutputMuted(muted);
    const audioElement = remoteAudioElementRef.current;
    if (!audioElement) return;
    audioElement.muted = muted || !remotePlaybackAllowedRef.current;
    if (!muted) resumeRemoteAudio();
  }

  function toggleDeviceMenu() {
    setDeviceMenuOpen((open) => {
      const next = !open;
      if (next) void loadDevices().catch(() => null);
      return next;
    });
  }

  function openDeviceManager() {
    setDeviceMenuOpen(false);
    setShowDeviceManager(true);
    void loadDevices().catch(() => null);
  }

  function selectManagedDevice(device: Device) {
    if (remoteSession?.deviceId === device.id) {
      setShowDeviceManager(false);
      resumeRemoteAudio();
      return;
    }
    if (device.status === "online") void connectDevice(device);
  }

  function startTalking(event: ReactPointerEvent<HTMLButtonElement>) {
    if ((event.pointerType === "mouse" && event.button !== 0) || activePointerRef.current !== null) return;
    event.preventDefault();
    activePointerRef.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Older mobile browsers can emit Pointer Events without supporting pointer capture.
    }
    resumeRemoteAudio();
    const track = micTrackRef.current;
    if (!track || mediaStatus !== "connected") return;
    reportClientMedia("ptt_unmute_requested", JSON.stringify({
      muted: track.isMuted,
      enabled: track.mediaStreamTrack.enabled,
      readyState: track.mediaStreamTrack.readyState,
    }));
    talkingRef.current = true;
    setTalking(true);
    void track.unmute().then(() => {
      reportClientMedia("ptt_unmuted", JSON.stringify({
        muted: track.isMuted,
        enabled: track.mediaStreamTrack.enabled,
        readyState: track.mediaStreamTrack.readyState,
      }));
      if (!talkingRef.current || micTrackRef.current !== track) void track.mute();
    }).catch(() => {
      talkingRef.current = false;
      setTalking(false);
      setNotice("麦克风暂时不可用，请重新连接设备");
    });
  }

  function stopTalking(event?: ReactPointerEvent<HTMLButtonElement>) {
    if (event && activePointerRef.current !== null && event.pointerId !== activePointerRef.current) return;
    event?.preventDefault();
    activePointerRef.current = null;
    talkingRef.current = false;
    setTalking(false);
    const track = micTrackRef.current;
    void track?.mute().then(() => reportClientMedia("ptt_muted", JSON.stringify({
      muted: track.isMuted,
      enabled: track.mediaStreamTrack.enabled,
      readyState: track.mediaStreamTrack.readyState,
    })));
  }

  useEffect(() => {
    const stopWhenInactive = () => {
      if (document.visibilityState === "hidden" || !document.hasFocus()) {
        activePointerRef.current = null;
        talkingRef.current = false;
        setTalking(false);
        void micTrackRef.current?.mute();
      }
    };
    window.addEventListener("blur", stopWhenInactive);
    document.addEventListener("visibilitychange", stopWhenInactive);
    return () => {
      window.removeEventListener("blur", stopWhenInactive);
      document.removeEventListener("visibilitychange", stopWhenInactive);
    };
  }, []);

  function unlockRemoteAudioFromGesture() {
    const audioElement = remoteAudioElementRef.current;
    if (!audioElement || audioElement.srcObject) {
      resumeRemoteAudio();
      return;
    }
    const sampleCount = 2_400;
    const wav = new ArrayBuffer(44 + sampleCount * 2);
    const view = new DataView(wav);
    const writeText = (offset: number, value: string) => {
      for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
    };
    writeText(0, "RIFF");
    view.setUint32(4, 36 + sampleCount * 2, true);
    writeText(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 48_000, true);
    view.setUint32(28, 96_000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, "data");
    view.setUint32(40, sampleCount * 2, true);
    const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
    audioElement.src = url;
    audioElement.muted = audioOutputMutedRef.current;
    void audioElement.play().catch(() => null).finally(() => {
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    });
  }

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      try {
        const { user: current } = await request<{ user: AuthUser }>("/api/v1/auth/me");
        if (cancelled) return;
        setUser(current);
      } catch {
        if (!cancelled) {
          setUser(null);
          setLoading(false);
        }
        return;
      }

      try {
        const currentDevices = await loadDevices();
        const { session } = await request<{ session: RemoteSession | null }>("/api/v1/sessions/active");
        if (cancelled) return;
        if (session) {
          const device = currentDevices.find((candidate) => candidate.id === session.deviceId);
          if (device) {
            setRemoteSession(session);
            setActiveDevice(device);
            setShowDeviceManager(false);
            setConnectingId(device.id);
            setLoading(false);
            try {
              await activateSession(session, device);
            } catch (error) {
              if (!cancelled) {
                await request(`/api/v1/sessions/${session.id}/stop`, { method: "POST", body: "{}" }).catch(() => null);
                await disconnectMedia();
                setConnectingId(null);
                setRemoteSession(null);
                setActiveDevice(null);
                setShowDeviceManager(true);
                setNotice((error as Error).message);
              }
            }
          }
        }
      } catch (error) {
        if (!cancelled) {
          await disconnectMedia();
          setConnectingId(null);
          setShowDeviceManager(true);
          setNotice((error as Error).message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void initialize();
    return () => {
      cancelled = true;
      void disconnectMedia();
    };
    // Initialization intentionally runs once; session restoration owns the initial media connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return <main className="shell center"><LoaderCircle className="spin" aria-label="正在加载" /></main>;
  }

  if (!user) {
    return (
      <main className="shell login-shell">
        <section className="brand-block">
          <div className="brand-mark"><Waves /></div>
          <p className="eyebrow">GPT-Live Remote</p>
          <h1>连接你的 Mac</h1>
          <p>使用邮箱验证码安全登录，然后扫描 Mac 上的配对二维码。</p>
        </section>
        {loginStep === "email" ? (
          <form className="stack" onSubmit={sendLoginCode}>
            <label htmlFor="email">邮箱</label>
            <input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" autoComplete="email" required />
            <button className="primary" type="submit">获取验证码</button>
          </form>
        ) : (
          <form className="stack" onSubmit={verifyLogin}>
            <button className="text-button back" type="button" onClick={() => setLoginStep("email")}><ArrowLeft /> 返回修改邮箱</button>
            <label htmlFor="code">邮箱验证码</label>
            <input id="code" inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} placeholder="输入 6 位验证码" autoComplete="one-time-code" required />
            <button className="primary" type="submit">登录</button>
          </form>
        )}
        {notice && <p className="notice error">{notice}</p>}
        <div className="security-card"><LockKeyhole /><div><strong>安全登录</strong><span>设备列表只对你的账号可见</span></div></div>
        <p className="server-line"><Server /> 服务器已加密连接</p>
      </main>
    );
  }

  if (activeDevice && remoteSession && !showDeviceManager) {
    const replyActive = replying;
    const connectionStatus = mediaStatus === "connected"
      ? audioPlaybackStatus === "blocked" ? "已连接 · 浏览器暂未播放音频"
        : audioPlaybackStatus === "error" ? "已连接 · 音频播放失败"
          : audioPlaybackStatus === "ready" ? "已连接 · 音频回传已就绪"
            : "已连接 · 等待 GPT 音频"
      : mediaStatus === "connecting" ? "正在恢复连接" : "连接已中断 · 请重新连接设备";
    return (
      <main className="shell session-shell">
        <header className="session-header">
          <button className="icon-button session-back" type="button" onClick={openDeviceManager} aria-label="返回设备管理" title="返回设备管理"><ArrowLeft /></button>
          <div className="device-selector" ref={deviceMenuRef}>
            <button className="device-pill" type="button" onClick={toggleDeviceMenu} aria-haspopup="listbox" aria-expanded={deviceMenuOpen}>
              <DeviceIcon kind={activeDevice.kind} /><span className="online-dot" /> <strong>{activeDevice.name}</strong><ChevronDown />
            </button>
            {deviceMenuOpen && (
              <div className="device-dropdown" role="listbox" aria-label="切换音频源">
                {devices.filter((device) => device.status === "online").map((device) => {
                  const selected = device.id === activeDevice.id;
                  return (
                    <button className="device-option" type="button" role="option" aria-selected={selected} key={device.id} disabled={selected || connectingId !== null || disconnecting} onClick={() => void connectDevice(device)}>
                      <span className="device-option-icon"><DeviceIcon kind={device.kind} /></span>
                      <span><strong>{device.name}</strong><small>{selected ? "当前音频源" : "在线"}</small></span>
                      {selected && <Check aria-hidden />}
                    </button>
                  );
                })}
                {devices.every((device) => device.status !== "online") && <p className="device-dropdown-empty">暂无在线设备</p>}
              </div>
            )}
          </div>
          <div className="session-actions">
            <button className="icon-button" type="button" onClick={toggleAudioOutputMute} aria-pressed={audioOutputMuted} aria-label={audioOutputMuted ? "恢复回传音频" : "静音回传音频"} title={audioOutputMuted ? "恢复回传音频" : "静音回传音频"}>{audioOutputMuted ? <VolumeX /> : <Volume2 />}</button>
          </div>
        </header>
        <p className="connection-line"><span className={mediaStatus === "connected" ? "online-dot" : "offline-dot"} /> {connectionStatus}</p>
        <section className="voice-stage">
          <div className="voice-space" aria-hidden />
          <div className={`voice-dots ${talking || replyActive ? "active" : ""}`} aria-hidden>
            {waveLevels.map((level, index) => <i key={index} style={{ height: `${8 + level * 28}px` }} />)}
          </div>
          <div className="voice-controls" ref={voiceControlsRef}>
            <p className="voice-status">{talking ? "正在发送" : "按住说话"}</p>
            <button className={`ptt ${talking ? "pressed" : ""}`} type="button" aria-label={talking ? "松开发送" : "按住说话"} onPointerDown={startTalking} onPointerUp={stopTalking} onPointerCancel={stopTalking} onLostPointerCapture={stopTalking} onContextMenu={(event) => event.preventDefault()}>
              <Mic />
            </button>
          </div>
        </section>
        {notice && <p className="notice error session-notice">{notice}</p>}
      </main>
    );
  }

  return (
    <main className="shell devices-shell">
      <header className="title-row">
        <div><p className="eyebrow">GPT-Live Remote</p><h1>我的设备</h1><p>{remoteSession ? "管理已连接和可用设备" : "选择一台设备开始连接"}</p></div>
        <div className="title-actions">
          <button className="icon-button" onClick={() => void loadDevices()} aria-label="刷新设备"><RefreshCw /></button>
        </div>
      </header>
      <section className="device-list">
        {devices.map((device) => {
          const isConnected = remoteSession?.deviceId === device.id;
          return (
            <article className={`device-card ${isConnected ? "connected" : ""}`} key={device.id}>
              <button className="device-card-target" type="button" disabled={(!isConnected && device.status !== "online") || connectingId !== null || disconnecting} onClick={() => selectManagedDevice(device)} aria-label={isConnected ? `打开 ${device.name} 当前会话` : `连接 ${device.name}`}>
                <span className="device-icon"><DeviceIcon kind={device.kind} /></span>
                <span className="device-copy"><strong>{device.name}</strong><span><i className={device.status === "online" ? "online-dot" : "offline-dot"} /> {isConnected ? "当前已连接" : device.status === "online" ? "在线 · Bridge 已就绪" : "离线"}</span></span>
              </button>
              <button className={`connect-button ${isConnected ? "disconnect" : ""}`} disabled={device.status !== "online" || connectingId !== null || disconnecting} onClick={() => isConnected ? void stopCurrentSession() : void connectDevice(device)}>
                {connectingId === device.id || (isConnected && disconnecting) ? <LoaderCircle className="spin" aria-label={isConnected ? "正在断开" : "正在连接"} /> : isConnected ? "断开连接" : device.status === "online" ? "连接设备" : "不可用"}
              </button>
            </article>
          );
        })}
      </section>
      <form className="pair-card" onSubmit={pairDevice}>
        <div><QrCode /><span><strong>添加 Mac</strong><small>输入 Mac Bridge 显示的配对码</small></span></div>
        <div className="pair-controls"><input value={pairCode} onChange={(event) => setPairCode(event.target.value)} placeholder="配对码" maxLength={10} required /><button type="submit" disabled={pairing}>{pairing ? <LoaderCircle className="spin" /> : "绑定"}</button></div>
      </form>
      {devices.length === 0 && <div className="empty-state"><Monitor /><strong>还没有已配对的 Mac</strong><span>在 Mac 上启动开发版 Bridge，然后输入它显示的配对码。</span></div>}
      {notice && <p className="notice error devices-notice">{notice}</p>}
      <p className="account-line">已登录 {user.email}</p>
      {microphoneRecovery && (
        <div className="permission-backdrop" role="presentation">
          <section className="permission-dialog" role="dialog" aria-modal="true" aria-labelledby="microphone-permission-title">
            <div className="permission-icon"><Mic aria-hidden /></div>
            <h2 id="microphone-permission-title">允许使用麦克风</h2>
            <p>{microphoneRecovery.message}</p>
            <div className="permission-actions">
              <button className="text-button" type="button" onClick={() => setMicrophoneRecovery(null)}>取消</button>
              <button className="primary" type="button" disabled={requestingMicrophone} onClick={() => void retryMicrophonePermission()}>{requestingMicrophone ? <LoaderCircle className="spin" aria-label="正在请求权限" /> : "重新授权"}</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
