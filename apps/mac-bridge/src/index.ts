import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import qrcode from "qrcode-terminal";
import WebSocket from "ws";
import { desktopVoiceConfigFromEnv, startAndVerifyVoice, stopAndVerifyVoice } from "./desktop-voice.js";
import { MacAudioBridge } from "./media-bridge.js";

type DeviceConfig = { id: string; name: string; kind: "macbook" | "macmini"; secret: string };
type ServerMessage =
  | { type: "bridge.hello"; deviceId: string }
  | { type: "bridge.heartbeat.ack"; at: number }
  | { type: "pairing.request"; requestId: string; email: string; confirmationCode: string }
  | { type: "session.start"; sessionId: string; media?: { url: string; token: string } | null }
  | { type: "session.ensure_voice"; sessionId: string }
  | { type: "session.stop"; sessionId: string };

const apiBase = process.env.CONTROL_API_BASE?.replace(/\/$/, "");
if (!apiBase) throw new Error("CONTROL_API_BASE is required");
const defaultConfigDir = join(homedir(), ".gpt-live-remote");
const configuredPath = process.env.BRIDGE_CONFIG_PATH?.replace(/^~(?=\/)/, homedir());
const configPath = resolve(configuredPath || join(defaultConfigDir, "device.json"));
const configDir = resolve(configPath, "..");
const readline = createInterface({ input: process.stdin, output: process.stdout });
mkdirSync(configDir, { recursive: true });

function readEnrollmentToken() {
  if (process.env.BRIDGE_ENROLLMENT_TOKEN) return process.env.BRIDGE_ENROLLMENT_TOKEN.trim();
  const tokenPath = resolve(process.env.BRIDGE_TOKEN_FILE || ".bridge-token");
  if (!existsSync(tokenPath)) throw new Error(`Bridge enrollment token not found: ${tokenPath}`);
  return readFileSync(tokenPath, "utf8").trim();
}

async function enroll(): Promise<DeviceConfig> {
  const response = await fetch(`${apiBase}/api/v1/bridge/enroll`, {
    method: "POST",
    headers: { authorization: `Bearer ${readEnrollmentToken()}`, "content-type": "application/json" },
    body: JSON.stringify({
      name: process.env.DEVICE_NAME || "工作室 MacBook Pro",
      kind: process.env.DEVICE_KIND === "macmini" ? "macmini" : "macbook",
    }),
  });
  const body = await response.json() as { device?: DeviceConfig; error?: string };
  if (!response.ok || !body.device) throw new Error(body.error || `Enrollment failed (${response.status})`);
  writeFileSync(configPath, JSON.stringify(body.device, null, 2), { mode: 0o600 });
  return body.device;
}

async function getPairing(device: DeviceConfig) {
  const response = await fetch(`${apiBase}/api/v1/bridge/pairing-code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: device.id, deviceSecret: device.secret }),
  });
  const body = await response.json() as { paired?: boolean; pairingCode?: string; pairingUrl?: string; error?: string };
  if (!response.ok) throw new Error(body.error || "Unable to create pairing code");
  if (body.paired) {
    console.log("✓ 这台 Mac 已绑定账号，等待手机连接。\n");
    return;
  }
  console.log("\n在手机登录 GPT-Live Remote 后输入以下配对码：");
  console.log(`\n  ${body.pairingCode}\n`);
  if (body.pairingUrl) qrcode.generate(body.pairingUrl, { small: true });
  console.log("配对码 10 分钟内有效。\n");
}

const device = existsSync(configPath)
  ? JSON.parse(readFileSync(configPath, "utf8")) as DeviceConfig
  : await enroll();

const wsUrl = new URL(`${apiBase}/api/v1/bridge/ws`);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
wsUrl.searchParams.set("deviceId", device.id);

console.log(`GPT-Live Remote Bridge (development)\n设备：${device.name}\n连接：${wsUrl.origin}\n`);
const socket = new WebSocket(wsUrl, {
  headers: { authorization: `Bearer ${device.secret}` },
});
let heartbeat: NodeJS.Timeout | null = null;
let activeMedia: MacAudioBridge | null = null;
let activeSessionId: string | null = null;
let voiceStartedForActiveSession = false;
let sessionTransition = Promise.resolve();
let shuttingDown = false;

function sendServer(message: Record<string, unknown>) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

async function shutdown(exitCode: number, reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (heartbeat) clearInterval(heartbeat);
  const media = activeMedia;
  activeMedia = null;
  await media?.close().catch((error) => console.error(`媒体清理失败：${error.message}`));
  await sessionTransition.catch(() => null);
  if (activeSessionId && process.env.MEDIA_ONLY_MODE !== "true") {
    await stopAndVerifyVoice(desktopVoiceConfigFromEnv()).catch((error) => console.error(`Voice 清理失败：${error.message}`));
  }
  activeSessionId = null;
  voiceStartedForActiveSession = false;
  if (socket.readyState === WebSocket.OPEN) socket.close(1000, reason);
  readline.close();
  process.exitCode = exitCode;
}

socket.on("open", async () => {
  console.log("✓ 控制通道已连接");
  heartbeat = setInterval(() => sendServer({ type: "bridge.heartbeat" }), 15_000);
  await getPairing(device).catch((error) => console.error(`配对码获取失败：${error.message}`));
});

socket.on("message", async (raw) => {
  const message = JSON.parse(raw.toString()) as ServerMessage;
  if (message.type === "bridge.hello") {
    console.log(`✓ Bridge 已注册 (${message.deviceId.slice(0, 8)})`);
  } else if (message.type === "pairing.request") {
    console.log(`\n配对请求：${message.email}`);
    console.log(`确认码：${message.confirmationCode}`);
    const autoApprove = process.env.AUTO_APPROVE_PAIRING === "true";
    const answer = autoApprove ? "y" : await readline.question("允许此账号绑定这台 Mac？[y/N] ");
    socket.send(JSON.stringify({
      type: answer.trim().toLowerCase() === "y" ? "pairing.approve" : "pairing.reject",
      requestId: message.requestId,
    }));
    console.log(answer.trim().toLowerCase() === "y" ? "✓ 已批准配对\n" : "已拒绝配对\n");
  } else if (message.type === "session.start") {
    sessionTransition = sessionTransition.then(async () => {
      if (shuttingDown) return;
      console.log(`\n▶ 收到启动请求 ${message.sessionId.slice(0, 8)}`);
      console.log("  正在启动 Codex Voice 并验证音频输入状态…");
      let media: MacAudioBridge | null = null;
      let voiceStartAttempted = false;
      try {
        if (!message.media?.url || !message.media.token) throw new Error("media_credentials_missing");
        if (activeSessionId === message.sessionId && activeMedia) {
          sendServer({ type: "session.ready", sessionId: message.sessionId });
          return;
        }
        const previousMedia = activeMedia;
        activeMedia = null;
        await previousMedia?.close();
        if (activeSessionId && process.env.MEDIA_ONLY_MODE !== "true") {
          await stopAndVerifyVoice(desktopVoiceConfigFromEnv());
        }
        activeSessionId = null;
        voiceStartedForActiveSession = false;
        if (shuttingDown) throw new Error("bridge_shutting_down");
        media = new MacAudioBridge((reason) => {
          sessionTransition = sessionTransition.then(async () => {
            if (activeMedia !== media) return;
            activeMedia = null;
            if (activeSessionId === message.sessionId && voiceStartedForActiveSession && process.env.MEDIA_ONLY_MODE !== "true") {
              await stopAndVerifyVoice(desktopVoiceConfigFromEnv()).catch(() => null);
            }
            activeSessionId = null;
            voiceStartedForActiveSession = false;
            sendServer({ type: "session.failed", sessionId: message.sessionId, reason });
          });
        });
        activeMedia = media;
        await media.connect({ ...message.media, sessionId: message.sessionId });
        if (shuttingDown) throw new Error("bridge_shutting_down");
        console.log("✓ 双向 WebRTC 与 BlackHole 音频链路已就绪");
        if (process.env.MEDIA_ONLY_MODE === "true") {
          activeSessionId = message.sessionId;
          console.log("✓ 媒体测试模式：跳过 Codex Voice 启动\n");
          sendServer({ type: "session.ready", sessionId: message.sessionId });
          return;
        }
        const config = desktopVoiceConfigFromEnv();
        voiceStartAttempted = true;
        const voice = await startAndVerifyVoice(config);
        voiceStartedForActiveSession = !voice.alreadyActive;
        voiceStartAttempted = voiceStartedForActiveSession;
        console.log(`[audio][${message.sessionId}][codex.input] ${JSON.stringify({ active: voice.audio.input, pids: voice.audio.pids })}`);
        activeSessionId = message.sessionId;
        console.log("✓ Codex Voice 音频输入已验证\n");
        sendServer({ type: "session.ready", sessionId: message.sessionId });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "desktop_start_failed";
        console.error(`✗ Codex Voice 启动未确认：${reason}\n`);
        if (activeMedia === media) activeMedia = null;
        await media?.close();
        if (voiceStartAttempted && process.env.MEDIA_ONLY_MODE !== "true") {
          await stopAndVerifyVoice(desktopVoiceConfigFromEnv()).catch(() => null);
        }
        activeSessionId = null;
        voiceStartedForActiveSession = false;
        sendServer({ type: "session.failed", sessionId: message.sessionId, reason });
      }
    });
    await sessionTransition;
  } else if (message.type === "session.ensure_voice") {
    sessionTransition = sessionTransition.then(async () => {
      if (shuttingDown) return;
      if (activeSessionId !== message.sessionId || !activeMedia) {
        sendServer({ type: "session.voice.failed", sessionId: message.sessionId, reason: "media_session_not_active" });
        return;
      }
      if (process.env.MEDIA_ONLY_MODE === "true") {
        sendServer({ type: "session.voice.ready", sessionId: message.sessionId });
        return;
      }
      try {
        const voice = await startAndVerifyVoice(desktopVoiceConfigFromEnv());
        if (!voice.alreadyActive) voiceStartedForActiveSession = true;
        console.log(`[audio][${message.sessionId}][codex.input.ensure] ${JSON.stringify({ active: voice.audio.input, pids: voice.audio.pids, alreadyActive: Boolean(voice.alreadyActive) })}`);
        sendServer({ type: "session.voice.ready", sessionId: message.sessionId });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "voice_audio_input_unverified";
        console.error(`✗ Codex Voice 状态恢复未确认：${reason}\n`);
        sendServer({ type: "session.voice.failed", sessionId: message.sessionId, reason });
      }
    });
    await sessionTransition;
  } else if (message.type === "session.stop") {
    sessionTransition = sessionTransition.then(async () => {
      if (activeSessionId && activeSessionId !== message.sessionId) {
        sendServer({ type: "session.stopped", sessionId: message.sessionId });
        return;
      }
      console.log(`\n■ 收到断开请求 ${message.sessionId.slice(0, 8)}`);
      try {
        const media = activeMedia;
        activeMedia = null;
        await media?.close();
        if (process.env.MEDIA_ONLY_MODE !== "true") {
          await stopAndVerifyVoice(desktopVoiceConfigFromEnv());
        }
        activeSessionId = null;
        voiceStartedForActiveSession = false;
        console.log("✓ 媒体链路与 Codex Voice 已关闭\n");
        sendServer({ type: "session.stopped", sessionId: message.sessionId });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "desktop_stop_failed";
        activeMedia = null;
        activeSessionId = null;
        voiceStartedForActiveSession = false;
        if (process.env.MEDIA_ONLY_MODE !== "true") {
          await stopAndVerifyVoice(desktopVoiceConfigFromEnv()).catch(() => null);
        }
        console.error(`✗ Codex Voice 关闭未确认：${reason}\n`);
        sendServer({ type: "session.stop_failed", sessionId: message.sessionId, reason });
      }
    });
    await sessionTransition;
  }
});

socket.on("close", (code, reason) => {
  if (!shuttingDown) console.error(`控制通道已断开 (${code}) ${reason.toString()}`);
  void shutdown(code === 1000 ? 0 : 1, "control channel closed");
});

socket.on("error", (error) => console.error(`连接错误：${error.message}`));
process.on("SIGINT", () => void shutdown(0, "user exit"));
process.on("SIGTERM", () => void shutdown(0, "service restart"));
