"use client";

import {
  ArrowLeft,
  ArrowUp,
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
  Type,
  Volume2,
  Waves,
} from "lucide-react";
import { FormEvent, PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import type { LocalAudioTrack, Room } from "livekit-client";

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
type Mode = "voice" | "text";
const appBasePath = process.env.NEXT_PUBLIC_APP_BASE_PATH ?? "";
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
  const response = await fetch(`${appBasePath}${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "请求失败，请稍后重试");
  return payload;
}

function DeviceIcon({ kind }: { kind: Device["kind"] }) {
  return kind === "macmini" ? <Square aria-hidden /> : <Laptop aria-hidden />;
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
  const [activeDevice, setActiveDevice] = useState<Device | null>(null);
  const [remoteSession, setRemoteSession] = useState<RemoteSession | null>(null);
  const [mode, setMode] = useState<Mode>("voice");
  const [talking, setTalking] = useState(false);
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<Array<{ side: "user" | "system"; text: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const roomRef = useRef<Room | null>(null);
  const micTrackRef = useRef<LocalAudioTrack | null>(null);
  const remoteAudioElementsRef = useRef<HTMLMediaElement[]>([]);

  const disconnectMedia = useCallback(async () => {
    const track = micTrackRef.current;
    micTrackRef.current = null;
    if (track) {
      await track.mute().catch(() => null);
      track.stop();
    }
    const room = roomRef.current;
    roomRef.current = null;
    if (room) await room.disconnect();
    remoteAudioElementsRef.current.forEach((element) => element.remove());
    remoteAudioElementsRef.current = [];
  }, []);

  const loadDevices = useCallback(async () => {
    const result = await request<{ devices: Device[] }>("/api/v1/devices");
    setDevices(result.devices);
  }, []);

  useEffect(() => {
    request<{ user: AuthUser }>("/api/v1/auth/me")
      .then(({ user: current }) => {
        setUser(current);
        return loadDevices();
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      void disconnectMedia();
    };
  }, [disconnectMedia, loadDevices]);

  useEffect(() => {
    const stopTalking = () => {
      if (document.visibilityState === "hidden" || !document.hasFocus()) void setPtt(false);
    };
    document.addEventListener("visibilitychange", stopTalking);
    window.addEventListener("blur", stopTalking);
    return () => {
      document.removeEventListener("visibilitychange", stopTalking);
      window.removeEventListener("blur", stopTalking);
    };
  });

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

  async function connectDevice(device: Device) {
    setConnectingId(device.id);
    setNotice(null);
    try {
      const { createLocalAudioTrack, Room, RoomEvent, Track } = await import("livekit-client");
      const localMic = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      await localMic.mute();
      const result = await request<{ session: RemoteSession }>("/api/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ deviceId: device.id }),
      });
      if (result.session.media) {
        const room = new Room({ adaptiveStream: false, dynacast: false });
        room.on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind !== Track.Kind.Audio) return;
          const element = track.attach();
          element.autoplay = true;
          element.style.display = "none";
          document.body.appendChild(element);
          remoteAudioElementsRef.current.push(element);
        });
        room.on(RoomEvent.TrackUnsubscribed, (track) => {
          track.detach().forEach((element) => {
            element.remove();
            remoteAudioElementsRef.current = remoteAudioElementsRef.current.filter((candidate) => candidate !== element);
          });
        });
        await room.connect(result.session.media.url, result.session.media.token, { autoSubscribe: true });
        await room.localParticipant.publishTrack(localMic, {
          name: "phone-microphone",
          source: Track.Source.Microphone,
        });
        await room.startAudio().catch(() => null);
        roomRef.current = room;
        micTrackRef.current = localMic;
        await request(`/api/v1/sessions/${result.session.id}/media-ready`, { method: "POST", body: "{}" });
      } else {
        localMic.stop();
      }
      const poll = async () => {
        const latest = await request<{ session: RemoteSession }>(`/api/v1/sessions/${result.session.id}`);
        if (latest.session.status === "ready") {
          if (pollRef.current) clearInterval(pollRef.current);
          setRemoteSession(latest.session);
          setActiveDevice(device);
          setConnectingId(null);
        } else if (latest.session.status === "failed") {
          if (pollRef.current) clearInterval(pollRef.current);
          setConnectingId(null);
          await disconnectMedia();
          setNotice(sessionFailureMessages[latest.session.failureReason || ""] || "连接失败，请检查 Mac Bridge 的诊断信息");
        }
      };
      await poll();
      pollRef.current = setInterval(() => void poll().catch(() => null), 900);
    } catch (error) {
      setConnectingId(null);
      await disconnectMedia();
      setNotice((error as Error).message);
    }
  }

  async function setPtt(active: boolean) {
    if (!remoteSession || active === talking) return;
    setTalking(active);
    const track = micTrackRef.current;
    if (track) {
      if (active) await track.unmute();
      else await track.mute();
    }
    await request(`/api/v1/sessions/${remoteSession.id}/ptt`, {
      method: "POST",
      body: JSON.stringify({ active }),
    }).catch(() => setNotice("控制事件发送失败"));
  }

  function handlePointerDown(event: PointerEvent<HTMLButtonElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    void setPtt(true);
  }

  function handlePointerUp() {
    void setPtt(false);
  }

  async function sendText(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!remoteSession || !value) return;
    setText("");
    setMessages((current) => [...current, { side: "user", text: value }]);
    try {
      await request(`/api/v1/sessions/${remoteSession.id}/text`, {
        method: "POST",
        body: JSON.stringify({ text: value }),
      });
      setMessages((current) => [...current, { side: "system", text: "已发送到 Mac Bridge" }]);
    } catch {
      setMessages((current) => [...current, { side: "system", text: "发送失败，请重试" }]);
    }
  }

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

  if (activeDevice && remoteSession) {
    return (
      <main className="shell session-shell">
        <header className="session-header">
          <button className="device-pill" type="button" onClick={() => { void disconnectMedia(); setActiveDevice(null); setRemoteSession(null); }}>
            <Laptop /><span className="online-dot" /> <strong>{activeDevice.name}</strong><ChevronDown />
          </button>
          <button className="mode-button" type="button" onClick={() => setMode(mode === "voice" ? "text" : "voice")}>
            {mode === "voice" ? <Type /> : <Waves />}{mode === "voice" ? "文字" : "语音"}
          </button>
        </header>
        <p className="connection-line"><span className="online-dot" /> 已连接 · 控制通道正常</p>
        {mode === "voice" ? (
          <section className="voice-stage">
            <p className="voice-status">{talking ? "正在发送到 Mac" : "按住按钮开始说话"}</p>
            <div className={`wave ${talking ? "active" : ""}`} aria-hidden>
              {Array.from({ length: 17 }, (_, index) => <i key={index} style={{ "--i": index } as React.CSSProperties} />)}
            </div>
            <button className={`ptt ${talking ? "pressed" : ""}`} type="button" onPointerDown={handlePointerDown} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp} onContextMenu={(event) => event.preventDefault()}>
              <Mic /> <span>{talking ? "正在说话" : "按住说话"}</span>
            </button>
            <p className="helper">松开发送</p>
            <button className="output-card" type="button"><Volume2 /><span><small>音频输出</small>跟随手机系统</span><ChevronDown /></button>
          </section>
        ) : (
          <section className="text-stage">
            <div className="messages">
              <p className="system-message"><Check /> 已连接 Mac Bridge</p>
              {messages.map((message, index) => <p className={`bubble ${message.side}`} key={`${message.text}-${index}`}>{message.text}</p>)}
            </div>
            <form className="composer" onSubmit={sendText}>
              <input value={text} onChange={(event) => setText(event.target.value)} placeholder="输入消息…" aria-label="输入消息" />
              <button type="submit" aria-label="发送"><ArrowUp /></button>
            </form>
          </section>
        )}
        {notice && <p className="notice error">{notice}</p>}
      </main>
    );
  }

  return (
    <main className="shell devices-shell">
      <header className="title-row"><div><p className="eyebrow">GPT-Live Remote</p><h1>我的设备</h1><p>选择一台设备开始连接</p></div><button className="icon-button" onClick={() => void loadDevices()} aria-label="刷新设备"><RefreshCw /></button></header>
      <section className="device-list">
        {devices.map((device) => (
          <article className="device-card" key={device.id}>
            <div className="device-icon"><DeviceIcon kind={device.kind} /></div>
            <div className="device-copy"><strong>{device.name}</strong><span><i className={device.status === "online" ? "online-dot" : "offline-dot"} /> {device.status === "online" ? "在线 · Bridge 已就绪" : "离线"}</span></div>
            <button className="connect-button" disabled={device.status !== "online" || connectingId !== null} onClick={() => void connectDevice(device)}>
              {connectingId === device.id ? <LoaderCircle className="spin" aria-label="正在连接" /> : device.status === "online" ? "连接设备" : "不可用"}
            </button>
          </article>
        ))}
      </section>
      <form className="pair-card" onSubmit={pairDevice}>
        <div><QrCode /><span><strong>添加 Mac</strong><small>输入 Mac Bridge 显示的配对码</small></span></div>
        <div className="pair-controls"><input value={pairCode} onChange={(event) => setPairCode(event.target.value)} placeholder="配对码" maxLength={10} required /><button type="submit" disabled={pairing}>{pairing ? <LoaderCircle className="spin" /> : "绑定"}</button></div>
      </form>
      {devices.length === 0 && <div className="empty-state"><Monitor /><strong>还没有已配对的 Mac</strong><span>在 Mac 上启动开发版 Bridge，然后输入它显示的配对码。</span></div>}
      {notice && <p className="notice error">{notice}</p>}
      <p className="account-line">已登录 {user.email}</p>
    </main>
  );
}
