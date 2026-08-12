import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import qrcode from "qrcode-terminal";
import WebSocket from "ws";
import { desktopVoiceConfigFromEnv, startAndVerifyVoice } from "./desktop-voice.js";

type DeviceConfig = { id: string; name: string; kind: "macbook" | "macmini"; secret: string };
type ServerMessage =
  | { type: "bridge.hello"; deviceId: string }
  | { type: "bridge.heartbeat.ack"; at: number }
  | { type: "pairing.request"; requestId: string; email: string; confirmationCode: string }
  | { type: "session.start"; sessionId: string }
  | { type: "session.ptt"; sessionId: string; active: boolean }
  | { type: "session.text"; sessionId: string; text: string };

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

socket.on("open", async () => {
  console.log("✓ 控制通道已连接");
  heartbeat = setInterval(() => socket.send(JSON.stringify({ type: "bridge.heartbeat" })), 15_000);
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
    console.log(`\n▶ 收到启动请求 ${message.sessionId.slice(0, 8)}`);
    console.log("  正在激活 ChatGPT 并验证 Voice 界面状态…");
    try {
      const config = desktopVoiceConfigFromEnv();
      await startAndVerifyVoice(config);
      console.log("✓ ChatGPT Voice 界面已验证\n");
      socket.send(JSON.stringify({ type: "session.ready", sessionId: message.sessionId }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "desktop_start_failed";
      console.error(`✗ ChatGPT Voice 启动未确认：${reason}\n`);
      socket.send(JSON.stringify({ type: "session.failed", sessionId: message.sessionId, reason }));
    }
  } else if (message.type === "session.ptt") {
    console.log(message.active ? "🎙 手机正在按住说话" : "✓ 手机已松开说话按钮");
  } else if (message.type === "session.text") {
    console.log(`✉ 手机文字：${message.text}`);
  }
});

socket.on("close", (code, reason) => {
  if (heartbeat) clearInterval(heartbeat);
  console.error(`控制通道已断开 (${code}) ${reason.toString()}`);
  process.exitCode = 1;
  readline.close();
});

socket.on("error", (error) => console.error(`连接错误：${error.message}`));
process.on("SIGINT", () => {
  socket.close(1000, "user exit");
  readline.close();
});
