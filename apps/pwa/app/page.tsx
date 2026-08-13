"use client";

import {
  ArrowLeft,
  Check,
  ChevronDown,
  HardDrive,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  Mic,
  Monitor,
  Pencil,
  QrCode,
  RefreshCw,
  Server,
  Smartphone,
  Tablet,
  Volume2,
  VolumeX,
  Waves,
} from "lucide-react";
import { FormEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  DeviceSessionRuntime,
  type RuntimeSession as RemoteSession,
  type RuntimeSnapshot,
} from "./device-session-runtime";

type AuthUser = { id: string; email: string };
type DeviceKind = "phone" | "tablet" | "macbook" | "macmini";
type Device = {
  id: string;
  name: string;
  kind: DeviceKind;
  status: "online" | "offline";
  lastSeen: string | null;
};
type WaveLevels = [number, number, number];
type MicrophoneRecovery = { device: Device; message: string };
const appBasePath = process.env.NEXT_PUBLIC_APP_BASE_PATH ?? "";
const lastLiveDeviceKey = "gpt-live-remote:last-live-device";
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
  chatgpt_app_not_found: "Mac 上未找到支持 Voice 的 Codex Desktop",
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

function DeviceIcon({ kind }: { kind: DeviceKind }) {
  const props = { "aria-hidden": true, strokeWidth: 1.5 } as const;
  if (kind === "phone") return <Smartphone {...props} />;
  if (kind === "tablet") return <Tablet {...props} />;
  if (kind === "macmini") return <HardDrive {...props} />;
  return <Laptop {...props} />;
}

type DevicePresentationTone = "connected" | "connecting" | "retained" | "connectable" | "unavailable";

function devicePresentationStatus(options: {
  device: Device;
  selected: boolean;
  session?: RemoteSession;
  snapshot?: RuntimeSnapshot;
  connecting: boolean;
  reconnecting: boolean;
}): { tone: DevicePresentationTone; label: string } {
  const { device, selected, session, snapshot, connecting, reconnecting } = options;
  if (device.status === "offline") return { tone: "unavailable", label: "不可用" };
  if (!selected && session) return { tone: "retained", label: "后台保留" };
  if (reconnecting) return { tone: "connecting", label: "正在重连" };
  if (selected && snapshot?.mediaStatus === "failed") return { tone: "unavailable", label: "连接失败" };
  if (selected && snapshot?.mediaStatus === "connected" && snapshot.voiceReady) {
    return { tone: "connected", label: "已连接" };
  }
  if (selected && (connecting || Boolean(session) || snapshot?.mediaStatus === "connecting")) {
    return { tone: "connecting", label: "连接中" };
  }
  return { tone: "connectable", label: "可连接" };
}

function isMicrophoneAccessError(error: unknown) {
  const candidate = error as { name?: string; message?: string };
  return candidate.name === "NotAllowedError"
    || candidate.name === "SecurityError"
    || /麦克风连接超时|permission|denied|not allowed/i.test(candidate.message || "");
}

function isNetworkFailure(error: unknown) {
  const message = (error as Error).message || "";
  if (isMicrophoneAccessError(error)) return false;
  return error instanceof TypeError || /网络|媒体连接|控制连接|fetch|connection|timeout|连接超时/i.test(message);
}

export default function Home() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [loginStep, setLoginStep] = useState<"email" | "code">("email");
  const [devices, setDevices] = useState<Device[]>([]);
  const [sessions, setSessions] = useState<Record<string, RemoteSession>>({});
  const [snapshots, setSnapshots] = useState<Record<string, RuntimeSnapshot>>({});
  const [activeDevice, setActiveDevice] = useState<Device | null>(null);
  const [showDeviceManager, setShowDeviceManager] = useState(false);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const [pairCode, setPairCode] = useState("");
  const [pairing, setPairing] = useState(false);
  const [microphoneRecovery, setMicrophoneRecovery] = useState<MicrophoneRecovery | null>(null);
  const [requestingMicrophone, setRequestingMicrophone] = useState(false);
  const [audioOutputMuted, setAudioOutputMuted] = useState(false);
  const [talking, setTalking] = useState(false);
  const [waveLevels, setWaveLevels] = useState<WaveLevels>([0, 0, 0]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingDevice, setEditingDevice] = useState<Device | null>(null);
  const [editName, setEditName] = useState("");
  const [editKind, setEditKind] = useState<DeviceKind>("macmini");
  const [savingDevice, setSavingDevice] = useState(false);

  const runtimesRef = useRef(new Map<string, DeviceSessionRuntime>());
  const sessionsRef = useRef<Record<string, RemoteSession>>({});
  const devicesRef = useRef<Device[]>([]);
  const activeDeviceIdRef = useRef<string | null>(null);
  const showDeviceManagerRef = useRef(false);
  const reconnectTimersRef = useRef(new Map<string, ReturnType<typeof window.setTimeout>>());
  const connectionPromisesRef = useRef(new Map<string, Promise<void>>());
  const activePointerRef = useRef<number | null>(null);
  const voiceControlsRef = useRef<HTMLDivElement | null>(null);
  const deviceMenuRef = useRef<HTMLDivElement | null>(null);
  const connectDeviceRef = useRef<(device: Device, reconnect?: boolean) => Promise<void>>(async () => undefined);

  useEffect(() => {
    devicesRef.current = devices;
  }, [devices]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    activeDeviceIdRef.current = activeDevice?.id || null;
  }, [activeDevice]);
  useEffect(() => {
    showDeviceManagerRef.current = showDeviceManager;
  }, [showDeviceManager]);

  const setSession = useCallback((deviceId: string, session: RemoteSession | null) => {
    setSessions((current) => {
      const next = { ...current };
      if (session) next[deviceId] = session;
      else delete next[deviceId];
      sessionsRef.current = next;
      return next;
    });
  }, []);

  const loadDevices = useCallback(async () => {
    const result = await request<{ devices: Device[] }>("/api/v1/devices");
    setDevices(result.devices);
    devicesRef.current = result.devices;
    return result.devices;
  }, []);

  const loadActiveSessions = useCallback(async () => {
    const result = await request<{ sessions: RemoteSession[]; session?: RemoteSession | null }>("/api/v1/sessions/active");
    const next = Object.fromEntries((result.sessions || (result.session ? [result.session] : [])).map((session) => [session.deviceId, session]));
    setSessions(next);
    sessionsRef.current = next;
    return next;
  }, []);

  const clearReconnect = useCallback((deviceId: string) => {
    const timer = reconnectTimersRef.current.get(deviceId);
    if (timer) window.clearTimeout(timer);
    reconnectTimersRef.current.delete(deviceId);
  }, []);

  const scheduleReconnect = useCallback((deviceId: string) => {
    clearReconnect(deviceId);
    if (activeDeviceIdRef.current !== deviceId || showDeviceManagerRef.current) return;
    const device = devicesRef.current.find((candidate) => candidate.id === deviceId);
    if (!device) return;
    reconnectTimersRef.current.set(deviceId, window.setTimeout(() => {
      reconnectTimersRef.current.delete(deviceId);
      if (activeDeviceIdRef.current === deviceId && !showDeviceManagerRef.current) {
        void connectDeviceRef.current(device, true);
      }
    }, 1_500));
  }, [clearReconnect]);

  const closeRuntime = useCallback(async (deviceId: string) => {
    const runtime = runtimesRef.current.get(deviceId);
    if (!runtime) return;
    runtimesRef.current.delete(deviceId);
    await runtime.close();
  }, []);

  const runtimeCallbacks = useCallback((deviceId: string) => ({
    onSnapshot: (runtime: DeviceSessionRuntime, snapshot: RuntimeSnapshot) => {
      if (runtimesRef.current.get(deviceId) !== runtime) return;
      setSnapshots((current) => ({ ...current, [deviceId]: snapshot }));
      setSession(deviceId, snapshot.session);
    },
    onTerminal: (runtime: DeviceSessionRuntime, reason: string) => {
      if (runtimesRef.current.get(deviceId) !== runtime) return;
      const terminalSnapshot = { ...runtime.snapshot(), mediaStatus: "failed" as const, failure: reason || "连接已结束" };
      setSnapshots((current) => ({ ...current, [deviceId]: terminalSnapshot }));
      setSession(deviceId, null);
      void closeRuntime(deviceId);
      if (activeDeviceIdRef.current === deviceId && !showDeviceManagerRef.current) {
        setTalking(false);
        setNotice(/idle|timeout/i.test(reason) ? "连接已超时" : "连接已断开");
      }
    },
    onNetworkDisconnected: (runtime: DeviceSessionRuntime) => {
      if (runtimesRef.current.get(deviceId) !== runtime) return;
      void closeRuntime(deviceId).finally(() => {
        if (activeDeviceIdRef.current === deviceId && !showDeviceManagerRef.current) {
          setNotice("连接正在恢复");
          scheduleReconnect(deviceId);
        }
      });
    },
  }), [closeRuntime, scheduleReconnect, setSession]);

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

  const unlockRemoteAudioFromGesture = useCallback(() => {
    const samples = 1_200;
    const wav = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(wav);
    const text = (offset: number, value: string) => {
      for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
    };
    text(0, "RIFF");
    view.setUint32(4, 36 + samples * 2, true);
    text(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 48_000, true);
    view.setUint32(28, 96_000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, samples * 2, true);
    const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
    const audio = new Audio(url);
    audio.muted = true;
    void audio.play().catch(() => null).finally(() => window.setTimeout(() => URL.revokeObjectURL(url), 1_000));
  }, []);

  const startRuntime = useCallback(async (device: Device, session: RemoteSession) => {
    const existing = runtimesRef.current.get(device.id);
    if (existing) {
      await existing.setForeground(activeDeviceIdRef.current === device.id && !showDeviceManagerRef.current);
      return;
    }
    const callbacks = runtimeCallbacks(device.id);
    const runtime = new DeviceSessionRuntime({
      session,
      microphoneConstraints,
      request,
      appBasePath,
      foreground: activeDeviceIdRef.current === device.id && !showDeviceManagerRef.current,
      outputMuted: audioOutputMuted,
      ...callbacks,
    });
    runtimesRef.current.set(device.id, runtime);
    setSnapshots((current) => ({ ...current, [device.id]: runtime.snapshot() }));
    try {
      await runtime.connect();
      const ready = session.status === "ready"
        ? await request<{ ok: true }>(`/api/v1/sessions/${session.id}/ensure-voice`, { method: "POST", body: "{}" }).then(() => session)
        : await waitForSessionReady(session.id);
      runtime.updateSession(ready);
      setSession(device.id, ready);
      if (activeDeviceIdRef.current === device.id) {
        setConnectingId(null);
        setNotice(null);
        await runtime.resumePlayback().catch(() => null);
      }
    } catch (error) {
      runtime.fail((error as Error).message);
      await closeRuntime(device.id);
      throw error;
    }
  }, [audioOutputMuted, closeRuntime, runtimeCallbacks, setSession]);

  const connectDevice = useCallback(async (device: Device, reconnect = false) => {
    clearReconnect(device.id);
    const previousId = activeDeviceIdRef.current;
    if (previousId && previousId !== device.id) {
      setTalking(false);
      activePointerRef.current = null;
      clearReconnect(previousId);
      const previousRuntime = runtimesRef.current.get(previousId);
      if (previousRuntime) void previousRuntime.setForeground(false).catch(() => null);
    }
    // Selection is a synchronous UI action. Media handoff continues after the
    // Live page has already switched to the chosen device.
    activeDeviceIdRef.current = device.id;
    showDeviceManagerRef.current = false;
    setActiveDevice(device);
    setShowDeviceManager(false);
    setDeviceMenuOpen(false);
    setConnectingId(device.id);
    setNotice(reconnect ? "连接正在恢复" : null);
    setMicrophoneRecovery(null);
    window.localStorage.setItem(lastLiveDeviceKey, device.id);
    unlockRemoteAudioFromGesture();

    const pending = connectionPromisesRef.current.get(device.id);
    if (pending) {
      await pending;
      const pendingRuntime = runtimesRef.current.get(device.id);
      if (pendingRuntime && activeDeviceIdRef.current === device.id && !showDeviceManagerRef.current) {
        await pendingRuntime.setForeground(true);
      }
      return;
    }
    const existingRuntime = runtimesRef.current.get(device.id);
    if (existingRuntime) {
      try {
        existingRuntime.setOutputMuted(audioOutputMuted);
        existingRuntime.setVoiceReady(false);
        await existingRuntime.setForeground(true);
        await request<{ ok: true }>(`/api/v1/sessions/${existingRuntime.session.id}/ensure-voice`, { method: "POST", body: "{}" });
        existingRuntime.setVoiceReady(true);
        if (activeDeviceIdRef.current === device.id) setNotice(null);
      } catch (error) {
        existingRuntime.setVoiceReady(false);
        if (activeDeviceIdRef.current === device.id) setNotice((error as Error).message);
      } finally {
        setConnectingId((current) => current === device.id ? null : current);
      }
      return;
    }

    const operation = (async () => {
      let session: RemoteSession | null = null;
      try {
        const active = await loadActiveSessions();
        session = active[device.id] || null;
        if (!session) {
          const result = await request<{ session: RemoteSession }>("/api/v1/sessions", {
            method: "POST",
            body: JSON.stringify({ deviceId: device.id }),
          });
          session = result.session;
          setSession(device.id, session);
        }
        await startRuntime(device, session);
      } catch (error) {
        const message = (error as Error).message;
        setSnapshots((current) => ({
          ...current,
          [device.id]: {
            session: session || { id: "", deviceId: device.id, status: "failed" },
            mediaStatus: "failed",
            playbackStatus: "idle",
            voiceReady: false,
            failure: message,
          },
        }));
        if (activeDeviceIdRef.current === device.id) {
          setConnectingId(null);
          setNotice(message);
        }
        if (isMicrophoneAccessError(error)) {
          if (session?.id) await request(`/api/v1/sessions/${session.id}/stop`, { method: "POST", body: "{}" }).catch(() => null);
          setSession(device.id, null);
          setMicrophoneRecovery({ device, message: "需要麦克风权限才能连接。请重新授权后继续。" });
        } else if (isNetworkFailure(error)) {
          if (activeDeviceIdRef.current === device.id && !showDeviceManagerRef.current) scheduleReconnect(device.id);
        } else {
          if (session?.id) await request(`/api/v1/sessions/${session.id}/stop`, { method: "POST", body: "{}" }).catch(() => null);
          setSession(device.id, null);
        }
      } finally {
        connectionPromisesRef.current.delete(device.id);
        setConnectingId((current) => current === device.id ? null : current);
      }
    })();
    connectionPromisesRef.current.set(device.id, operation);
    return operation;
  }, [audioOutputMuted, clearReconnect, loadActiveSessions, scheduleReconnect, setSession, startRuntime, unlockRemoteAudioFromGesture]);

  useEffect(() => {
    connectDeviceRef.current = connectDevice;
  }, [connectDevice]);

  async function stopDeviceSession(deviceId: string) {
    if (disconnectingId) return;
    clearReconnect(deviceId);
    setDisconnectingId(deviceId);
    setNotice(null);
    const session = sessionsRef.current[deviceId];
    try {
      if (session?.id) await request(`/api/v1/sessions/${session.id}/stop`, { method: "POST", body: "{}" });
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      await closeRuntime(deviceId);
      setSession(deviceId, null);
      setSnapshots((current) => {
        const next = { ...current };
        delete next[deviceId];
        return next;
      });
      if (activeDeviceIdRef.current === deviceId) {
        activeDeviceIdRef.current = null;
        setActiveDevice(null);
        setTalking(false);
        setShowDeviceManager(true);
        showDeviceManagerRef.current = true;
        window.localStorage.removeItem(lastLiveDeviceKey);
      }
      setDisconnectingId(null);
      await Promise.all([loadDevices(), loadActiveSessions()]).catch(() => null);
    }
  }

  function openDeviceManager() {
    setDeviceMenuOpen(false);
    setTalking(false);
    activePointerRef.current = null;
    showDeviceManagerRef.current = true;
    setShowDeviceManager(true);
    const activeId = activeDeviceIdRef.current;
    const activeRuntime = activeId ? runtimesRef.current.get(activeId) : null;
    if (activeRuntime) void activeRuntime.setForeground(false).catch(() => null);
    void Promise.all([loadDevices(), loadActiveSessions()]).catch(() => null);
  }

  function selectManagedDevice(device: Device) {
    if (sessionsRef.current[device.id] || device.status === "online") void connectDevice(device);
  }

  function toggleDeviceMenu() {
    setDeviceMenuOpen((open) => {
      const next = !open;
      if (next) void loadDevices().catch(() => null);
      return next;
    });
  }

  function toggleAudioOutputMute() {
    const next = !audioOutputMuted;
    setAudioOutputMuted(next);
    const activeId = activeDeviceIdRef.current;
    if (activeId) runtimesRef.current.get(activeId)?.setOutputMuted(next);
  }

  function startTalking(event: ReactPointerEvent<HTMLButtonElement>) {
    if ((event.pointerType === "mouse" && event.button !== 0) || activePointerRef.current !== null) return;
    event.preventDefault();
    const runtime = activeDeviceIdRef.current ? runtimesRef.current.get(activeDeviceIdRef.current) : null;
    if (!runtime) return;
    activePointerRef.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is optional on older mobile browsers.
    }
    void runtime.resumePlayback().catch(() => null);
    void runtime.startTalking().then((started) => {
      if (!started || activePointerRef.current !== event.pointerId) {
        activePointerRef.current = null;
        void runtime.stopTalking();
        return;
      }
      setTalking(true);
    }).catch(() => {
      activePointerRef.current = null;
      setTalking(false);
      setNotice("麦克风暂时不可用，请重新连接设备");
    });
  }

  function stopTalking(event?: ReactPointerEvent<HTMLButtonElement>) {
    if (event && activePointerRef.current !== null && event.pointerId !== activePointerRef.current) return;
    event?.preventDefault();
    activePointerRef.current = null;
    setTalking(false);
    const activeId = activeDeviceIdRef.current;
    if (activeId) void runtimesRef.current.get(activeId)?.stopTalking();
  }

  async function retryMicrophonePermission() {
    if (!microphoneRecovery || requestingMicrophone) return;
    const recovery = microphoneRecovery;
    setRequestingMicrophone(true);
    try {
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints }),
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
      setRequestingMicrophone(false);
    }
  }

  function beginEditDevice(device: Device) {
    setEditingDevice(device);
    setEditName(device.name);
    setEditKind(device.kind);
  }

  async function saveDevice(event: FormEvent) {
    event.preventDefault();
    if (!editingDevice || savingDevice) return;
    setSavingDevice(true);
    try {
      await request(`/api/v1/devices/${editingDevice.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editName.trim(), kind: editKind }),
      });
      const updated = { ...editingDevice, name: editName.trim(), kind: editKind };
      setDevices((current) => current.map((device) => device.id === updated.id ? updated : device));
      if (activeDeviceIdRef.current === updated.id) setActiveDevice(updated);
      setEditingDevice(null);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setSavingDevice(false);
    }
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
      await Promise.all([loadDevices(), loadActiveSessions()]);
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

  useEffect(() => {
    if (!deviceMenuOpen) return;
    const close = (event: globalThis.PointerEvent) => {
      if (!deviceMenuRef.current?.contains(event.target as Node)) setDeviceMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [deviceMenuOpen]);

  useEffect(() => {
    const inside = (node: Node | null) => Boolean(node && voiceControlsRef.current?.contains(node));
    const prevent = (event: Event) => {
      if (!inside(event.target as Node | null)) return;
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
    };
    document.addEventListener("selectstart", prevent, true);
    document.addEventListener("contextmenu", prevent, true);
    document.addEventListener("dragstart", prevent, true);
    return () => {
      document.removeEventListener("selectstart", prevent, true);
      document.removeEventListener("contextmenu", prevent, true);
      document.removeEventListener("dragstart", prevent, true);
    };
  }, []);

  useEffect(() => {
    if (!activeDevice || showDeviceManager) return;
    // A restored page may be blocked by mobile autoplay policy. Reuse the
    // next normal user gesture anywhere on the Live page to resume the actual
    // remote element; no separate "enable audio" control is required.
    const resume = () => {
      const runtime = runtimesRef.current.get(activeDevice.id);
      if (runtime) void runtime.resumePlayback().catch(() => null);
    };
    document.addEventListener("pointerdown", resume, true);
    return () => document.removeEventListener("pointerdown", resume, true);
  }, [activeDevice, showDeviceManager]);

  useEffect(() => {
    if (!activeDevice || showDeviceManager) return;
    let frame = 0;
    let last = 0;
    let smooth: WaveLevels = [0, 0, 0];
    const samples = new Uint8Array(256);
    const measure = (analyser: AnalyserNode | null): WaveLevels => {
      if (!analyser) return [0, 0, 0];
      analyser.getByteTimeDomainData(samples);
      const length = Math.floor(samples.length / 3);
      return [0, 1, 2].map((part) => {
        let energy = 0;
        const start = part * length;
        const end = part === 2 ? samples.length : start + length;
        for (let index = start; index < end; index += 1) {
          const value = (samples[index] - 128) / 128;
          energy += value * value;
        }
        return Math.min(1, Math.max(0, (Math.sqrt(energy / (end - start)) - 0.008) / 0.22));
      }) as WaveLevels;
    };
    const render = (time: number) => {
      if (time - last >= 45) {
        const runtime = runtimesRef.current.get(activeDevice.id);
        const local = measure(runtime?.localAnalyser || null);
        const remote = measure(runtime?.remoteAnalyser || null);
        const measured = Math.max(...remote) > 0.05 ? remote : local;
        smooth = smooth.map((value, index) => value * 0.58 + measured[index] * 0.42) as WaveLevels;
        setWaveLevels(smooth);
        last = time;
      }
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [activeDevice, showDeviceManager]);

  useEffect(() => {
    const stop = () => {
      if (document.visibilityState !== "hidden" && document.hasFocus()) return;
      activePointerRef.current = null;
      setTalking(false);
      const activeId = activeDeviceIdRef.current;
      if (activeId) void runtimesRef.current.get(activeId)?.stopTalking();
    };
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", stop);
    return () => {
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", stop);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const reconnectTimers = reconnectTimersRef.current;
    const runtimes = runtimesRef.current;
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
        const [currentDevices, activeSessions] = await Promise.all([loadDevices(), loadActiveSessions()]);
        if (cancelled) return;
        const preferredId = window.localStorage.getItem(lastLiveDeviceKey);
        const preferred = preferredId ? currentDevices.find((device) => device.id === preferredId && activeSessions[device.id]) : null;
        const fallbackSession = Object.values(activeSessions)[0];
        const target = preferred || (fallbackSession ? currentDevices.find((device) => device.id === fallbackSession.deviceId) : null);
        if (target) {
          setLoading(false);
          await connectDeviceRef.current(target, true);
        } else {
          setShowDeviceManager(true);
          showDeviceManagerRef.current = true;
        }
      } catch (error) {
        if (!cancelled) {
          setShowDeviceManager(true);
          showDeviceManagerRef.current = true;
          setNotice((error as Error).message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void initialize();
    return () => {
      cancelled = true;
      reconnectTimers.forEach((timer) => window.clearTimeout(timer));
      reconnectTimers.clear();
      runtimes.forEach((runtime) => void runtime.close());
      runtimes.clear();
    };
    // Initialization owns restoration and intentionally runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <main className="shell center"><LoaderCircle className="spin" aria-label="正在加载" /></main>;

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

  if (activeDevice && !showDeviceManager) {
    const snapshot = snapshots[activeDevice.id];
    const mediaConnected = snapshot?.mediaStatus === "connected";
    const voiceReady = snapshot?.voiceReady === true;
    const activeStatus = devicePresentationStatus({
      device: activeDevice,
      selected: true,
      session: sessions[activeDevice.id],
      snapshot,
      connecting: connectingId === activeDevice.id,
      reconnecting: connectingId === activeDevice.id && notice === "连接正在恢复",
    });
    return (
      <main className="shell session-shell">
        <header className="session-header">
          <button className="icon-button session-back" type="button" onClick={openDeviceManager} aria-label="返回设备管理"><ArrowLeft /></button>
          <div className="device-selector" ref={deviceMenuRef}>
            <button className="device-pill" type="button" onClick={toggleDeviceMenu} aria-haspopup="listbox" aria-expanded={deviceMenuOpen}>
              <DeviceIcon kind={activeDevice.kind} />
              <span className={`device-status-dot ${activeStatus.tone}`} aria-hidden />
              <span className="device-pill-copy"><strong>{activeDevice.name}</strong><small>{activeStatus.label}</small></span>
              <ChevronDown className={`device-chevron ${deviceMenuOpen ? "open" : ""}`} />
            </button>
            {deviceMenuOpen && (
              <div className="device-dropdown" role="listbox" aria-label="切换设备">
                {devices.map((device) => {
                  const selected = device.id === activeDevice.id;
                  const status = devicePresentationStatus({
                    device,
                    selected,
                    session: sessions[device.id],
                    snapshot: snapshots[device.id],
                    connecting: connectingId === device.id,
                    reconnecting: selected && connectingId === device.id && notice === "连接正在恢复",
                  });
                  return (
                    <button className="device-option" type="button" role="option" aria-selected={selected} key={device.id} disabled={selected || status.tone === "unavailable"} onClick={() => void connectDevice(device)}>
                      <span className="device-option-icon"><DeviceIcon kind={device.kind} /></span>
                      <span className={`device-status-dot ${status.tone}`} aria-hidden />
                      <span className="device-option-copy"><strong>{device.name}</strong><small>{status.label}</small></span>
                      {selected && <Check aria-hidden />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="session-actions">
            <button className="icon-button" type="button" onClick={toggleAudioOutputMute} aria-pressed={audioOutputMuted} aria-label={audioOutputMuted ? "恢复回传音频" : "静音回传音频"}>{audioOutputMuted ? <VolumeX /> : <Volume2 />}</button>
          </div>
        </header>
        <section className="voice-stage">
          <div className="voice-space" aria-hidden />
          {mediaConnected && (
            <div className={`voice-dots ${talking || Math.max(...waveLevels) > 0.05 ? "active" : ""}`} aria-hidden>
              {waveLevels.map((level, index) => <i key={index} style={{ height: `${8 + level * 28}px` }} />)}
            </div>
          )}
          {voiceReady && mediaConnected && (
            <div className="voice-controls" ref={voiceControlsRef}>
              <p className="voice-status">{talking ? "正在发送" : "按住说话"}</p>
              <button className={`ptt ${talking ? "pressed" : ""}`} type="button" aria-label={talking ? "松开发送" : "按住说话"} onPointerDown={startTalking} onPointerUp={stopTalking} onPointerCancel={stopTalking} onLostPointerCapture={stopTalking} onContextMenu={(event) => event.preventDefault()}>
                <Mic />
              </button>
            </div>
          )}
        </section>
        {notice && <p className="notice error session-notice">{notice}</p>}
      </main>
    );
  }

  return (
    <main className="shell devices-shell">
      <header className="title-row">
        <div><p className="eyebrow">GPT-Live Remote</p><h1>我的设备</h1><p>{Object.keys(sessions).length ? "管理已连接和可用设备" : "选择一台设备开始连接"}</p></div>
        <div className="title-actions">
          <button className="icon-button" type="button" onClick={() => void Promise.all([loadDevices(), loadActiveSessions()])} aria-label="刷新设备"><RefreshCw /></button>
        </div>
      </header>
      <section className="device-list">
        {devices.map((device) => {
          const connected = Boolean(sessions[device.id]);
          const snapshot = snapshots[device.id];
          const connecting = !connected && (connectingId === device.id || snapshot?.mediaStatus === "connecting");
          return (
            <article className={`device-card ${connected ? "connected" : ""}`} key={device.id}>
              <button className="device-card-target" type="button" disabled={!connected && device.status !== "online"} onClick={() => selectManagedDevice(device)} aria-label={connected ? `打开 ${device.name} 当前会话` : `连接 ${device.name}`}>
                <span className="device-icon"><DeviceIcon kind={device.kind} /></span>
                <span className="device-copy"><strong>{device.name}</strong><span><i className={device.status === "online" ? "online-dot" : "offline-dot"} /> {connected ? "已连接" : device.status === "online" ? "在线 · Bridge 已就绪" : "离线"}</span></span>
              </button>
              <div className="device-card-actions">
                <button className="icon-button device-edit" type="button" onClick={() => beginEditDevice(device)} aria-label={`编辑 ${device.name}`}><Pencil /></button>
                <button className={`connect-button ${connected ? "disconnect" : ""}`} type="button" disabled={(!connected && device.status !== "online") || disconnectingId !== null} onClick={() => connected ? void stopDeviceSession(device.id) : void connectDevice(device)}>
                  {connecting || disconnectingId === device.id ? <LoaderCircle className="spin" aria-label={disconnectingId === device.id ? "正在断开" : "正在连接"} /> : connected ? "断开连接" : device.status === "online" ? "连接设备" : "不可用"}
                </button>
              </div>
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
      {editingDevice && (
        <div className="permission-backdrop" role="presentation">
          <form className="permission-dialog device-editor" onSubmit={saveDevice} role="dialog" aria-modal="true" aria-labelledby="device-editor-title">
            <h2 id="device-editor-title">编辑设备</h2>
            <label htmlFor="device-name">设备名称</label>
            <input id="device-name" value={editName} onChange={(event) => setEditName(event.target.value)} maxLength={80} required />
            <fieldset>
              <legend>设备图标</legend>
              <div className="device-kind-options">
                {([
                  ["phone", "手机"],
                  ["tablet", "Pad"],
                  ["macbook", "MacBook"],
                  ["macmini", "Mac mini"],
                ] as Array<[DeviceKind, string]>).map(([kind, label]) => (
                  <button className={`device-kind-option ${editKind === kind ? "selected" : ""}`} type="button" key={kind} onClick={() => setEditKind(kind)} aria-pressed={editKind === kind}>
                    <DeviceIcon kind={kind} /><span>{label}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="permission-actions">
              <button className="text-button" type="button" onClick={() => setEditingDevice(null)}>取消</button>
              <button className="primary" type="submit" disabled={savingDevice}>{savingDevice ? <LoaderCircle className="spin" aria-label="正在保存" /> : "保存"}</button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
