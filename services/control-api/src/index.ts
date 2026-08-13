import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Database from "better-sqlite3";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type WebSocket from "ws";
import type { RawData } from "ws";
import { z } from "zod";
import { AccessToken, TrackSource } from "livekit-server-sdk";

const env = z.object({
  PORT: z.coerce.number().default(8787),
  HOST: z.string().default("127.0.0.1"),
  PUBLIC_BASE_URL: z.string().url(),
  DATABASE_PATH: z.string().default("./data/control.sqlite"),
  COOKIE_SECRET: z.string().min(32),
  BRIDGE_ENROLLMENT_TOKEN: z.string().min(24),
  AUTH_DEMO_CODE: z.string().regex(/^\d{6}$/).optional(),
  SESSION_COOKIE_SECURE: z.enum(["true", "false"]).default("true"),
  LIVEKIT_URL: z.string().url().optional(),
  LIVEKIT_API_KEY: z.string().min(8).optional(),
  LIVEKIT_API_SECRET: z.string().min(24).optional(),
}).parse(process.env);

const liveKitValues = [env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET].filter(Boolean);
if (liveKitValues.length !== 0 && liveKitValues.length !== 3) {
  throw new Error("LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be configured together");
}
const liveKitConfigured = liveKitValues.length === 3;

mkdirSync(dirname(env.DATABASE_PATH), { recursive: true });
const db = new Database(env.DATABASE_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS login_codes (
    email TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    last_seen INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS pairing_codes (
    code_hash TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    FOREIGN KEY(device_id) REFERENCES devices(id)
  );
  CREATE TABLE IF NOT EXISTS pairing_requests (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    confirmation_code TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(device_id) REFERENCES devices(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS remote_sessions (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(device_id) REFERENCES devices(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS session_content (
    session_id TEXT NOT NULL,
    id TEXT NOT NULL,
    position INTEGER NOT NULL,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT,
    label TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(session_id, id),
    FOREIGN KEY(session_id) REFERENCES remote_sessions(id)
  );
`);
try {
  db.exec("ALTER TABLE remote_sessions ADD COLUMN failure_reason TEXT");
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes("duplicate column name")) throw error;
}
try {
  db.exec("ALTER TABLE remote_sessions ADD COLUMN start_dispatched INTEGER NOT NULL DEFAULT 0");
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes("duplicate column name")) throw error;
}
try {
  db.exec("ALTER TABLE remote_sessions ADD COLUMN last_voice_at INTEGER");
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes("duplicate column name")) throw error;
}

// Each enrolled Mac owns one media lease. An account may keep several Mac
// sessions alive while the phone selects exactly one foreground audio route.
db.prepare("UPDATE remote_sessions SET status = 'stopped' WHERE status = 'stopping'").run();
const duplicateActiveSessions = db.prepare(`
  SELECT id, device_id
  FROM remote_sessions
  WHERE status IN ('starting', 'ready')
  ORDER BY device_id, created_at DESC, id DESC
`).all() as Array<{ id: string; device_id: string }>;
const activeLeaseOwners = new Set<string>();
const staleActiveSessionIds: string[] = [];
for (const session of duplicateActiveSessions) {
  if (activeLeaseOwners.has(session.device_id)) staleActiveSessionIds.push(session.id);
  else activeLeaseOwners.add(session.device_id);
}
if (staleActiveSessionIds.length) {
  const stopStaleSession = db.prepare("UPDATE remote_sessions SET status = 'stopped' WHERE id = ? AND status IN ('starting', 'ready')");
  db.transaction((ids: string[]) => ids.forEach((id) => stopStaleSession.run(id)))(staleActiveSessionIds);
  console.warn(`Reconciled ${staleActiveSessionIds.length} duplicate active media lease(s)`);
}
db.exec(`
  DROP INDEX IF EXISTS remote_sessions_one_active_per_user;
  CREATE UNIQUE INDEX IF NOT EXISTS remote_sessions_one_active_per_device
  ON remote_sessions(device_id)
  WHERE status IN ('starting', 'ready', 'stopping')
`);
db.prepare("UPDATE remote_sessions SET last_voice_at = created_at WHERE last_voice_at IS NULL").run();

type User = { id: string; email: string };
type SessionContent = {
  id: string;
  order: number;
  role: "user" | "assistant";
  kind: "text" | "image" | "video" | "audio" | "file" | "unsupported";
  text?: string;
  label?: string;
};
type BridgeMessage =
  | { type: "bridge.heartbeat" }
  | { type: "pairing.approve"; requestId: string }
  | { type: "pairing.reject"; requestId: string }
  | { type: "session.ready"; sessionId: string }
  | { type: "session.failed"; sessionId: string; reason?: string }
  | { type: "session.stopped"; sessionId: string }
  | { type: "session.stop_failed"; sessionId: string; reason?: string }
  | { type: "session.content"; sessionId: string; content: SessionContent }
  | { type: "session.content.history"; sessionId: string; items: SessionContent[]; nextCursor: string | null };
type PhoneControlMessage =
  | { type: "control.heartbeat" }
  | { type: "client.media.status"; stage: "microphone_published" | "ptt_unmute_requested" | "ptt_unmuted" | "ptt_muted" | "rtc_stats" | "track_subscribed" | "track_unsubscribed" | "playback_ready" | "playback_blocked" | "playback_error"; detail?: string }
  | { type: "session.content.history.request"; before?: string | null; limit?: number };

const app = Fastify({ logger: { redact: ["req.headers.authorization", "req.headers.cookie"] } });
await app.register(cookie);
await app.register(rateLimit, { global: false });
await app.register(websocket);

const bridgeSockets = new Map<string, WebSocket>();
const phoneSessionSockets = new Map<string, Set<WebSocket>>();
const sessionReleaseTimers = new Map<string, NodeJS.Timeout>();
const sessionVoiceIdleMs = 15 * 60_000;
const sessionStopWaitAttempts = 24;
const now = () => Date.now();
const hmac = (value: string) => createHmac("sha256", env.COOKIE_SECRET).update(value).digest("hex");
const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
const randomPairCode = () => randomBytes(5).toString("base64url").replace(/[-_]/g, "A").slice(0, 8).toUpperCase();
const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const maskedEmail = (email: string) => {
  const [name, domain] = email.split("@");
  return `${name.slice(0, 1)}***@${domain}`;
};

function broadcastToSession(sessionId: string, message: Record<string, unknown>) {
  const payload = JSON.stringify({ sessionId, ...message });
  for (const socket of phoneSessionSockets.get(sessionId) || []) {
    if (socket.readyState === 1) socket.send(payload);
  }
}

function closePhoneSessionSockets(sessionId: string, reason: string) {
  const sockets = phoneSessionSockets.get(sessionId);
  phoneSessionSockets.delete(sessionId);
  for (const socket of sockets || []) {
    if (socket.readyState < 2) socket.close(4001, reason);
  }
}

function clearSessionRelease(sessionId: string) {
  const timer = sessionReleaseTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  sessionReleaseTimers.delete(sessionId);
}

function markSessionStopped(sessionId: string, deviceId: string, notifyBridge: boolean, closeReason = "session ended") {
  clearSessionRelease(sessionId);
  const changed = db.prepare("UPDATE remote_sessions SET status = 'stopped' WHERE id = ? AND status IN ('starting', 'ready', 'stopping')")
    .run(sessionId);
  if (changed.changes) closePhoneSessionSockets(sessionId, closeReason);
  if (!changed.changes || !notifyBridge) return;
  const bridge = bridgeSockets.get(deviceId);
  if (bridge?.readyState === 1) bridge.send(JSON.stringify({ type: "session.stop", sessionId }));
}

function scheduleSessionRelease(sessionId: string, deviceId: string, lastVoiceAt: number) {
  clearSessionRelease(sessionId);
  const active = db.prepare("SELECT id FROM remote_sessions WHERE id = ? AND status IN ('starting', 'ready')").get(sessionId);
  if (!active) return;
  const delayMs = Math.max(0, lastVoiceAt + sessionVoiceIdleMs - now());
  sessionReleaseTimers.set(sessionId, setTimeout(() => {
    sessionReleaseTimers.delete(sessionId);
    const latest = db.prepare("SELECT last_voice_at FROM remote_sessions WHERE id = ? AND status IN ('starting', 'ready')")
      .get(sessionId) as { last_voice_at: number | null } | undefined;
    if (!latest) return;
    const latestVoiceAt = latest.last_voice_at || lastVoiceAt;
    if (latestVoiceAt + sessionVoiceIdleMs > now()) {
      scheduleSessionRelease(sessionId, deviceId, latestVoiceAt);
      return;
    }
    markSessionStopped(sessionId, deviceId, true, "session idle timeout");
  }, delayMs));
}

const sessionContentSchema = z.object({
  id: z.string().min(1).max(200),
  order: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant"]),
  kind: z.enum(["text", "image", "video", "audio", "file", "unsupported"]),
  text: z.string().max(20_000).optional(),
  label: z.string().max(500).optional(),
});

function storeContent(sessionId: string, content: SessionContent) {
  db.prepare(`
    INSERT INTO session_content(session_id, id, position, role, kind, text, label, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, id) DO UPDATE SET
      position = excluded.position,
      role = excluded.role,
      kind = excluded.kind,
      text = excluded.text,
      label = excluded.label,
      updated_at = excluded.updated_at
  `).run(sessionId, content.id, content.order, content.role, content.kind, content.text || null, content.label || null, now());
}

async function liveKitToken(room: string, identity: string, role: "phone" | "bridge") {
  if (!liveKitConfigured) return null;
  const token = new AccessToken(env.LIVEKIT_API_KEY!, env.LIVEKIT_API_SECRET!, { identity, ttl: 5 * 60 });
  token.addGrant({
    roomJoin: true,
    room,
    canPublishSources: role === "phone" ? [TrackSource.MICROPHONE] : [TrackSource.SCREEN_SHARE_AUDIO],
    canSubscribe: true,
    canPublishData: false,
  });
  return token.toJwt();
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function getBearer(request: FastifyRequest) {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
}

function sessionUser(request: FastifyRequest): User | null {
  const raw = request.cookies.gpt_live_session;
  if (!raw) return null;
  return (db.prepare(`
    SELECT users.id, users.email
    FROM auth_sessions JOIN users ON users.id = auth_sessions.user_id
    WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?
  `).get(hmac(raw), now()) as User | undefined) || null;
}

function requireUser(request: FastifyRequest, reply: FastifyReply): User | null {
  const user = sessionUser(request);
  if (!user) {
    void reply.code(401).send({ error: "请先登录" });
    return null;
  }
  return user;
}

function ownedDevice(userId: string, deviceId: string) {
  return db.prepare("SELECT * FROM devices WHERE id = ? AND user_id = ?").get(deviceId, userId) as
    | { id: string; name: string; kind: string }
    | undefined;
}

app.get("/api/healthz", async () => ({ ok: true, service: "gpt-live-control" }));

app.post("/api/v1/auth/email/start", {
  config: { rateLimit: { max: 5, timeWindow: "10 minutes" } },
}, async (request, reply) => {
  const parsed = z.object({ email: z.email() }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "请输入有效邮箱" });
  if (!env.AUTH_DEMO_CODE) return reply.code(503).send({ error: "邮件服务尚未配置" });
  const email = normalizeEmail(parsed.data.email);
  const recent = db.prepare("SELECT created_at FROM login_codes WHERE email = ?").get(email) as { created_at: number } | undefined;
  if (recent && now() - recent.created_at < 60_000) return { ok: true };
  db.prepare(`
    INSERT INTO login_codes(email, code_hash, expires_at, attempts, created_at)
    VALUES (?, ?, ?, 0, ?)
    ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at
  `).run(email, hmac(env.AUTH_DEMO_CODE), now() + 10 * 60_000, now());
  request.log.info({ emailDomain: email.split("@")[1] }, "demo login code issued");
  return { ok: true };
});

app.post("/api/v1/auth/email/verify", {
  config: { rateLimit: { max: 10, timeWindow: "10 minutes" } },
}, async (request, reply) => {
  const parsed = z.object({ email: z.email(), code: z.string().regex(/^\d{6}$/) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "验证码格式不正确" });
  const email = normalizeEmail(parsed.data.email);
  const record = db.prepare("SELECT * FROM login_codes WHERE email = ?").get(email) as
    | { code_hash: string; expires_at: number; attempts: number }
    | undefined;
  if (!record || record.expires_at < now() || record.attempts >= 5 || !safeEqual(record.code_hash, hmac(parsed.data.code))) {
    if (record) db.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?").run(email);
    return reply.code(401).send({ error: "验证码无效或已过期" });
  }
  db.prepare("DELETE FROM login_codes WHERE email = ?").run(email);
  let user = db.prepare("SELECT id, email FROM users WHERE email = ?").get(email) as User | undefined;
  if (!user) {
    user = { id: randomUUID(), email };
    db.prepare("INSERT INTO users(id, email, created_at) VALUES (?, ?, ?)").run(user.id, user.email, now());
  }
  const token = randomToken();
  db.prepare("INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(randomUUID(), user.id, hmac(token), now() + 30 * 24 * 60 * 60_000, now());
  reply.setCookie("gpt_live_session", token, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: env.SESSION_COOKIE_SECURE === "true",
    maxAge: 30 * 24 * 60 * 60,
  });
  return { user };
});

app.get("/api/v1/auth/me", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) return;
  return { user };
});

app.post("/api/v1/auth/logout", async (request, reply) => {
  const token = request.cookies.gpt_live_session;
  if (token) db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(hmac(token));
  reply.clearCookie("gpt_live_session", { path: "/" });
  return { ok: true };
});

app.post("/api/v1/bridge/enroll", async (request, reply) => {
  const bearer = getBearer(request);
  if (!bearer || !safeEqual(bearer, env.BRIDGE_ENROLLMENT_TOKEN)) return reply.code(401).send({ error: "无效的 Bridge 注册凭据" });
  const parsed = z.object({ name: z.string().min(2).max(80), kind: z.enum(["macbook", "macmini"]).default("macbook") }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "设备信息无效" });
  const deviceId = randomUUID();
  const deviceSecret = randomToken();
  const pairingCode = randomPairCode();
  db.prepare("INSERT INTO devices(id, name, kind, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(deviceId, parsed.data.name, parsed.data.kind, hmac(deviceSecret), now());
  db.prepare("INSERT INTO pairing_codes(code_hash, device_id, expires_at) VALUES (?, ?, ?)")
    .run(hmac(pairingCode), deviceId, now() + 10 * 60_000);
  return {
    device: { id: deviceId, name: parsed.data.name, kind: parsed.data.kind, secret: deviceSecret },
    pairingCode,
    pairingUrl: `${env.PUBLIC_BASE_URL}/#pair=${pairingCode}`,
  };
});

app.post("/api/v1/bridge/pairing-code", async (request, reply) => {
  const parsed = z.object({ deviceId: z.string().uuid(), deviceSecret: z.string().min(20) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "设备凭据无效" });
  const device = db.prepare("SELECT id, user_id, secret_hash FROM devices WHERE id = ?").get(parsed.data.deviceId) as
    | { id: string; user_id: string | null; secret_hash: string }
    | undefined;
  if (!device || !safeEqual(device.secret_hash, hmac(parsed.data.deviceSecret))) return reply.code(401).send({ error: "设备凭据无效" });
  if (device.user_id) return { paired: true };
  const pairingCode = randomPairCode();
  db.prepare("DELETE FROM pairing_codes WHERE device_id = ?").run(device.id);
  db.prepare("INSERT INTO pairing_codes(code_hash, device_id, expires_at) VALUES (?, ?, ?)")
    .run(hmac(pairingCode), device.id, now() + 10 * 60_000);
  return { paired: false, pairingCode, pairingUrl: `${env.PUBLIC_BASE_URL}/#pair=${pairingCode}` };
});

app.get("/api/v1/bridge/ws", { websocket: true }, (socket, request) => {
  const query = z.object({ deviceId: z.string().uuid() }).safeParse(request.query);
  const secret = getBearer(request);
  if (!query.success || !secret) return socket.close(1008, "invalid credentials");
  const device = db.prepare("SELECT id, secret_hash FROM devices WHERE id = ?").get(query.data.deviceId) as { id: string; secret_hash: string } | undefined;
  if (!device || !safeEqual(device.secret_hash, hmac(secret))) return socket.close(1008, "invalid credentials");
  const previousSocket = bridgeSockets.get(device.id);
  bridgeSockets.set(device.id, socket);
  if (previousSocket && previousSocket !== socket && previousSocket.readyState < 2) {
    previousSocket.close(4001, "bridge connection replaced");
  }
  const staleSessions = db.prepare("SELECT id FROM remote_sessions WHERE device_id = ? AND status IN ('starting', 'ready')")
    .all(device.id) as Array<{ id: string }>;
  staleSessions.forEach((session) => clearSessionRelease(session.id));
  db.transaction(() => {
    db.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").run(now(), device.id);
    db.prepare("UPDATE remote_sessions SET status = 'stopped' WHERE device_id = ? AND status IN ('starting', 'ready')").run(device.id);
  })();
  staleSessions.forEach((session) => closePhoneSessionSockets(session.id, "bridge reconnected"));
  socket.send(JSON.stringify({ type: "bridge.hello", deviceId: device.id }));
  socket.on("message", (data: RawData) => {
    try {
      const message = JSON.parse(String(data)) as BridgeMessage;
      db.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").run(now(), device.id);
      if (message.type === "bridge.heartbeat") {
        socket.send(JSON.stringify({ type: "bridge.heartbeat.ack", at: now() }));
      } else if (message.type === "pairing.approve" || message.type === "pairing.reject") {
        const pending = db.prepare("SELECT * FROM pairing_requests WHERE id = ? AND device_id = ? AND status = 'pending'").get(message.requestId, device.id) as { id: string; user_id: string } | undefined;
        if (!pending) return;
        if (message.type === "pairing.approve") {
          db.transaction(() => {
            db.prepare("UPDATE devices SET user_id = ? WHERE id = ? AND user_id IS NULL").run(pending.user_id, device.id);
            db.prepare("UPDATE pairing_requests SET status = 'approved' WHERE id = ?").run(pending.id);
          })();
        } else {
          db.prepare("UPDATE pairing_requests SET status = 'rejected' WHERE id = ?").run(pending.id);
        }
      } else if (message.type === "session.ready" || message.type === "session.failed") {
        db.prepare("UPDATE remote_sessions SET status = ?, failure_reason = ? WHERE id = ? AND device_id = ? AND status = 'starting'")
          .run(
            message.type === "session.ready" ? "ready" : "failed",
            message.type === "session.failed" ? message.reason || "desktop_start_failed" : null,
            message.sessionId,
            device.id,
          );
        if (message.type === "session.failed") clearSessionRelease(message.sessionId);
      } else if (message.type === "session.stopped" || message.type === "session.stop_failed") {
        db.prepare("UPDATE remote_sessions SET status = ?, failure_reason = ? WHERE id = ? AND device_id = ? AND status IN ('starting', 'ready', 'stopping', 'stop_failed')")
          .run(
            message.type === "session.stopped" ? "stopped" : "stop_failed",
            message.type === "session.stop_failed" ? message.reason || "desktop_stop_failed" : null,
            message.sessionId,
            device.id,
          );
        clearSessionRelease(message.sessionId);
        if (message.type === "session.stopped") closePhoneSessionSockets(message.sessionId, "session ended");
      } else if (message.type === "session.content") {
        const parsed = z.object({
          type: z.literal("session.content"),
          sessionId: z.string().uuid(),
          content: sessionContentSchema,
        }).safeParse(message);
        if (!parsed.success) return;
        const active = db.prepare("SELECT id FROM remote_sessions WHERE id = ? AND device_id = ? AND status IN ('starting', 'ready')")
          .get(parsed.data.sessionId, device.id);
        if (!active) return;
        storeContent(parsed.data.sessionId, parsed.data.content);
        broadcastToSession(parsed.data.sessionId, { type: "session.content", content: parsed.data.content });
      } else if (message.type === "session.content.history") {
        const parsed = z.object({
          type: z.literal("session.content.history"),
          sessionId: z.string().uuid(),
          items: z.array(sessionContentSchema).max(50),
          nextCursor: z.string().max(50).nullable(),
        }).safeParse(message);
        if (!parsed.success) return;
        const active = db.prepare("SELECT id FROM remote_sessions WHERE id = ? AND device_id = ? AND status IN ('starting', 'ready')")
          .get(parsed.data.sessionId, device.id);
        if (!active) return;
        const storePage = db.transaction((items: SessionContent[]) => items.forEach((content) => storeContent(parsed.data.sessionId, content)));
        storePage(parsed.data.items);
        broadcastToSession(parsed.data.sessionId, {
          type: "session.content.history",
          items: parsed.data.items,
          nextCursor: parsed.data.nextCursor,
        });
      }
    } catch (error) {
      request.log.warn({ error }, "invalid bridge message");
    }
  });
  socket.on("close", () => {
    if (bridgeSockets.get(device.id) !== socket) return;
    bridgeSockets.delete(device.id);
    const activeSessions = db.prepare("SELECT id FROM remote_sessions WHERE device_id = ? AND status IN ('starting', 'ready')")
      .all(device.id) as Array<{ id: string }>;
    db.prepare("UPDATE remote_sessions SET status = 'stopped' WHERE device_id = ? AND status IN ('starting', 'ready')").run(device.id);
    activeSessions.forEach((session) => {
      clearSessionRelease(session.id);
      closePhoneSessionSockets(session.id, "bridge offline");
    });
  });
});

app.post("/api/v1/pairing/exchange", {
  config: { rateLimit: { max: 10, timeWindow: "10 minutes" } },
}, async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) return;
  const parsed = z.object({ code: z.string().min(6).max(12) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "配对码格式不正确" });
  const pairing = db.prepare("SELECT * FROM pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?")
    .get(hmac(parsed.data.code.trim().toUpperCase()), now()) as { code_hash: string; device_id: string } | undefined;
  if (!pairing) return reply.code(404).send({ error: "配对码无效或已过期" });
  const device = db.prepare("SELECT id, user_id FROM devices WHERE id = ?").get(pairing.device_id) as { id: string; user_id: string | null };
  if (device.user_id && device.user_id !== user.id) return reply.code(409).send({ error: "这台 Mac 已绑定其他账号" });
  const socket = bridgeSockets.get(device.id);
  if (!socket || socket.readyState !== 1) return reply.code(409).send({ error: "Mac Bridge 当前不在线" });
  const requestId = randomUUID();
  const confirmationCode = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare("INSERT INTO pairing_requests(id, device_id, user_id, confirmation_code, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
    .run(requestId, device.id, user.id, confirmationCode, now());
  socket.send(JSON.stringify({ type: "pairing.request", requestId, email: maskedEmail(user.email), confirmationCode }));
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await delay(500);
    const status = db.prepare("SELECT status FROM pairing_requests WHERE id = ?").get(requestId) as { status: string };
    if (status.status === "approved") {
      db.prepare("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?").run(now(), pairing.code_hash);
      return { ok: true };
    }
    if (status.status === "rejected") return reply.code(403).send({ error: "Mac 拒绝了本次配对" });
  }
  return reply.code(408).send({ error: "等待 Mac 确认超时" });
});

app.get("/api/v1/devices", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) return;
  const rows = db.prepare("SELECT id, name, kind, last_seen FROM devices WHERE user_id = ? ORDER BY created_at DESC").all(user.id) as Array<{ id: string; name: string; kind: "phone" | "tablet" | "macbook" | "macmini"; last_seen: number | null }>;
  return {
    devices: rows.map((device) => ({
      id: device.id,
      name: device.name,
      kind: device.kind,
      status: bridgeSockets.has(device.id) ? "online" : "offline",
      lastSeen: device.last_seen ? new Date(device.last_seen).toISOString() : null,
    })),
  };
});

app.patch("/api/v1/devices/:id", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) return;
  const id = z.string().uuid().safeParse((request.params as { id?: string }).id);
  if (!id.success) return reply.code(400).send({ error: "设备信息无效" });
  const parsed = z.object({
    name: z.string().trim().min(2).max(80),
    kind: z.enum(["phone", "tablet", "macbook", "macmini"]),
  }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "设备名称或图标无效" });
  const changed = db.prepare("UPDATE devices SET name = ?, kind = ? WHERE id = ? AND user_id = ?")
    .run(parsed.data.name, parsed.data.kind, id.data, user.id);
  if (!changed.changes) return reply.code(404).send({ error: "找不到这台设备" });
  return { device: { id: id.data, ...parsed.data } };
});

app.post("/api/v1/sessions", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) return;
  const parsed = z.object({ deviceId: z.string().uuid() }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "设备信息无效" });
  const device = ownedDevice(user.id, parsed.data.deviceId);
  if (!device) return reply.code(404).send({ error: "找不到这台设备" });
  const socket = bridgeSockets.get(device.id);
  if (!socket || socket.readyState !== 1) return reply.code(409).send({ error: "Mac Bridge 当前不在线" });
  const existing = db.prepare(`
    SELECT id, device_id as deviceId, status, failure_reason as failureReason,
           start_dispatched as startDispatched, created_at as createdAt,
           last_voice_at as lastVoiceAt
    FROM remote_sessions
    WHERE user_id = ? AND device_id = ? AND status IN ('starting', 'ready')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(user.id, device.id) as {
    id: string;
    deviceId: string;
    status: "starting" | "ready";
    failureReason: string | null;
    startDispatched: number;
    createdAt: number;
    lastVoiceAt: number | null;
  } | undefined;
  if (existing) {
    const token = await liveKitToken(existing.id, `phone:${user.id}`, "phone");
    scheduleSessionRelease(existing.id, existing.deviceId, existing.lastVoiceAt || existing.createdAt);
    return {
      session: {
        id: existing.id,
        deviceId: existing.deviceId,
        status: existing.status,
        failureReason: existing.failureReason,
        media: token ? { url: env.LIVEKIT_URL, token } : null,
      },
    };
  }

  const createdAt = now();
  const session = { id: randomUUID(), deviceId: device.id, status: "starting" as const };
  try {
    db.prepare("INSERT INTO remote_sessions(id, device_id, user_id, status, created_at, last_voice_at) VALUES (?, ?, ?, 'starting', ?, ?)")
      .run(session.id, device.id, user.id, createdAt, createdAt);
  } catch (error) {
    request.log.warn({ error, userId: user.id, deviceId: device.id }, "device media lease already exists");
    return reply.code(409).send({ error: "这台设备正在建立连接，请稍后重试" });
  }
  scheduleSessionRelease(session.id, device.id, createdAt);
  if (!liveKitConfigured) {
    db.prepare("UPDATE remote_sessions SET start_dispatched = 1 WHERE id = ?").run(session.id);
    socket.send(JSON.stringify({ type: "session.start", sessionId: session.id }));
    return { session };
  }
  const token = await liveKitToken(session.id, `phone:${user.id}`, "phone");
  return { session: { ...session, media: { url: env.LIVEKIT_URL, token } } };
});

app.post("/api/v1/sessions/:id/media-ready", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) return;
  if (!liveKitConfigured) return reply.code(409).send({ error: "媒体服务尚未配置" });
  const id = z.string().uuid().safeParse((request.params as { id?: string }).id);
  if (!id.success) return reply.code(400).send({ error: "会话信息无效" });
  const session = db.prepare("SELECT id, device_id, status, start_dispatched FROM remote_sessions WHERE id = ? AND user_id = ?")
    .get(id.data, user.id) as { id: string; device_id: string; status: string; start_dispatched: number } | undefined;
  if (!session) return reply.code(404).send({ error: "找不到会话" });
  if (session.status !== "starting") return { ok: session.status === "ready" };
  const socket = bridgeSockets.get(session.device_id);
  if (!socket || socket.readyState !== 1) return reply.code(409).send({ error: "Mac Bridge 当前不在线" });
  if (session.start_dispatched) return { ok: true };
  const token = await liveKitToken(session.id, `bridge:${session.device_id}`, "bridge");
  const claimed = db.prepare("UPDATE remote_sessions SET start_dispatched = 1 WHERE id = ? AND start_dispatched = 0 AND status = 'starting'").run(session.id);
  if (claimed.changes) {
    socket.send(JSON.stringify({
      type: "session.start",
      sessionId: session.id,
      media: { url: env.LIVEKIT_URL, token },
    }));
  }
  return { ok: true };
});

app.get("/api/v1/sessions/active", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) return;
  const sessions = db.prepare(`
    SELECT id, device_id as deviceId, status, failure_reason as failureReason,
           start_dispatched as startDispatched, created_at as createdAt,
           last_voice_at as lastVoiceAt
    FROM remote_sessions
    WHERE user_id = ? AND status IN ('starting', 'ready')
    ORDER BY created_at DESC
  `).all(user.id) as Array<{
    id: string;
    deviceId: string;
    status: "starting" | "ready";
    failureReason: string | null;
    startDispatched: number;
    createdAt: number;
    lastVoiceAt: number | null;
  }>;
  const active = [];
  for (const session of sessions) {
    if (!bridgeSockets.has(session.deviceId)) continue;
    if (session.status === "starting" && !session.startDispatched && now() - session.createdAt > 90_000) {
      markSessionStopped(session.id, session.deviceId, false);
      continue;
    }
    const token = await liveKitToken(session.id, `phone:${user.id}`, "phone");
    scheduleSessionRelease(session.id, session.deviceId, session.lastVoiceAt || session.createdAt);
    active.push({
      id: session.id,
      deviceId: session.deviceId,
      status: session.status,
      failureReason: session.failureReason,
      media: token ? { url: env.LIVEKIT_URL, token } : null,
    });
  }
  return { sessions: active, session: active[0] || null };
});

app.get("/api/v1/sessions/:id", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) return;
  const id = z.string().uuid().safeParse((request.params as { id?: string }).id);
  if (!id.success) return reply.code(400).send({ error: "会话信息无效" });
  const session = db.prepare("SELECT id, device_id as deviceId, status, failure_reason as failureReason FROM remote_sessions WHERE id = ? AND user_id = ?").get(id.data, user.id);
  if (!session) return reply.code(404).send({ error: "找不到会话" });
  return { session };
});

app.get("/api/v1/sessions/:id/ws", { websocket: true }, (socket, request) => {
  const user = sessionUser(request);
  const id = z.string().uuid().safeParse((request.params as { id?: string }).id);
  if (!user || !id.success) return socket.close(1008, "invalid session");
  const session = db.prepare("SELECT id, device_id FROM remote_sessions WHERE id = ? AND user_id = ? AND status IN ('starting', 'ready')")
    .get(id.data, user.id) as { id: string; device_id: string } | undefined;
  if (!session) return socket.close(4001, "session unavailable");

  const sessionSockets = phoneSessionSockets.get(session.id) || new Set<WebSocket>();
  sessionSockets.add(socket);
  phoneSessionSockets.set(session.id, sessionSockets);
  clearSessionRelease(session.id);
  socket.send(JSON.stringify({ type: "control.ready", sessionId: session.id }));
  const recentContent = db.prepare(`
    SELECT id, position as "order", role, kind, text, label
    FROM session_content
    WHERE session_id = ?
    ORDER BY position DESC
    LIMIT 20
  `).all(session.id) as SessionContent[];
  socket.send(JSON.stringify({
    type: "session.content.snapshot",
    sessionId: session.id,
    items: recentContent.reverse(),
    nextCursor: recentContent.length === 20 ? String(recentContent[0].order) : null,
  }));
  socket.on("message", (data: RawData) => {
    try {
      const active = db.prepare("SELECT id FROM remote_sessions WHERE id = ? AND status IN ('starting', 'ready')").get(session.id);
      if (!active) return socket.close(4001, "session ended");
      const parsed = z.discriminatedUnion("type", [
        z.object({ type: z.literal("control.heartbeat") }),
        z.object({
          type: z.literal("client.media.status"),
          stage: z.enum(["microphone_published", "ptt_unmute_requested", "ptt_unmuted", "ptt_muted", "rtc_stats", "track_subscribed", "track_unsubscribed", "playback_ready", "playback_blocked", "playback_error"]),
          detail: z.string().max(1_000).optional(),
        }),
        z.object({
          type: z.literal("session.content.history.request"),
          before: z.string().max(50).nullable().optional(),
          limit: z.number().int().min(1).max(50).optional(),
        }),
      ]).safeParse(JSON.parse(String(data)));
      if (!parsed.success) return socket.send(JSON.stringify({ type: "control.error", error: "invalid_message" }));
      const message = parsed.data as PhoneControlMessage;
      if (message.type === "control.heartbeat") {
        return socket.send(JSON.stringify({ type: "control.heartbeat.ack", at: now() }));
      }
      if (message.type === "client.media.status") {
        if (message.stage === "ptt_unmuted") {
          const voiceAt = now();
          db.prepare("UPDATE remote_sessions SET last_voice_at = ? WHERE id = ? AND status IN ('starting', 'ready')")
            .run(voiceAt, session.id);
          scheduleSessionRelease(session.id, session.device_id, voiceAt);
        }
        request.log.info({ sessionId: session.id, stage: message.stage, detail: message.detail }, "phone media status");
        return;
      }
      const bridge = bridgeSockets.get(session.device_id);
      if (!bridge || bridge.readyState !== 1) return socket.send(JSON.stringify({ type: "control.error", error: "bridge_offline" }));
      bridge.send(JSON.stringify({ sessionId: session.id, ...message }));
    } catch (error) {
      request.log.warn({ error, sessionId: session.id }, "invalid phone control message");
      socket.send(JSON.stringify({ type: "control.error", error: "invalid_message" }));
    }
  });
  socket.on("close", () => {
    sessionSockets.delete(socket);
    if (sessionSockets.size === 0) {
      phoneSessionSockets.delete(session.id);
    }
  });
});

app.post("/api/v1/sessions/:id/stop", async (request, reply) => {
  const user = requireUser(request, reply);
  if (!user) return;
  const id = z.string().uuid().safeParse((request.params as { id?: string }).id);
  if (!id.success) return reply.code(400).send({ error: "会话信息无效" });
  const session = db.prepare("SELECT id, device_id, status, start_dispatched FROM remote_sessions WHERE id = ? AND user_id = ?")
    .get(id.data, user.id) as { id: string; device_id: string; status: string; start_dispatched: number } | undefined;
  if (!session) return reply.code(404).send({ error: "找不到会话" });
  if (session.status === "stopped") return { ok: true };
  if (session.status === "starting" && !session.start_dispatched) {
    db.prepare("UPDATE remote_sessions SET status = 'stopped' WHERE id = ?").run(session.id);
    clearSessionRelease(session.id);
    closePhoneSessionSockets(session.id, "session ended");
    return { ok: true };
  }
  const socket = bridgeSockets.get(session.device_id);
  if (!socket || socket.readyState !== 1) {
    markSessionStopped(session.id, session.device_id, false);
    return { ok: true };
  }

  socket.send(JSON.stringify({ type: "session.stop", sessionId: session.id }));
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await delay(500);
    const latest = db.prepare("SELECT status, failure_reason FROM remote_sessions WHERE id = ?").get(session.id) as { status: string; failure_reason: string | null };
    if (latest.status === "stopped") return { ok: true };
    if (latest.status === "stop_failed") return reply.code(409).send({ error: latest.failure_reason || "Mac 未能关闭 GPT Voice" });
  }
  db.prepare("UPDATE remote_sessions SET status = 'stop_failed', failure_reason = ? WHERE id = ? AND status IN ('starting', 'ready')")
    .run("desktop_stop_timeout", session.id);
  clearSessionRelease(session.id);
  return reply.code(504).send({ error: "等待 Mac 关闭 GPT Voice 超时" });
});

await app.listen({ host: env.HOST, port: env.PORT });
