import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

export type SessionContent = {
  id: string;
  order: number;
  role: "user" | "assistant";
  kind: "text" | "image" | "video" | "audio" | "file" | "unsupported";
  text?: string;
  label?: string;
};

type RpcResponse = { id?: number; result?: unknown; error?: { message?: string } };
type ThreadSummary = { id: string; updatedAt: number; createdAt: number; preview?: string; cwd?: string };
type ThreadItem = Record<string, unknown> & { id?: string; type?: string };
type ThreadDetail = {
  id: string;
  threadSource?: string | null;
  turns?: Array<{ items?: ThreadItem[] }>;
};

class AppServerReader {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private requests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor() {
    const bundledCodex = "/Volumes/storage/Applications/ChatGPT.app/Contents/Resources/codex";
    const executable = process.env.CODEX_PATH || (existsSync(bundledCodex) ? bundledCodex : "codex");
    this.child = spawn(executable, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message: RpcResponse;
      try {
        message = JSON.parse(line) as RpcResponse;
      } catch {
        return;
      }
      if (typeof message.id !== "number") return;
      const request = this.requests.get(message.id);
      if (!request) return;
      this.requests.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message || "app_server_request_failed"));
      else request.resolve(message.result);
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line && !line.includes("ignoring interface.defaultPrompt")) console.error(`Codex content reader: ${line}`);
    });
    this.child.once("exit", (code) => {
      for (const request of this.requests.values()) request.reject(new Error(`app_server_exited:${code ?? "signal"}`));
      this.requests.clear();
    });
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "gpt-live-remote", title: "GPT-Live Remote", version: "0.1.0" },
      capabilities: {},
    });
    this.notify("initialized", {});
  }

  request(method: string, params: unknown) {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown) {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }
}

function extractTag(value: string, tag: string) {
  const match = value.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match?.[1]?.trim() || null;
}

function mediaKind(path: string): SessionContent["kind"] {
  const extension = path.split(/[?#]/)[0].split(".").pop()?.toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "heic"].includes(extension || "")) return "image";
  if (["mp4", "mov", "webm", "m4v"].includes(extension || "")) return "video";
  if (["mp3", "wav", "m4a", "aac", "flac", "ogg"].includes(extension || "")) return "audio";
  return "file";
}

function agentMediaContent(item: ThreadItem): Array<Omit<SessionContent, "order">> {
  const id = String(item.id || "agent");
  const source = typeof item.text === "string" ? item.text : "";
  const content: Array<Omit<SessionContent, "order">> = [];
  const mediaPattern = /!\[([^\]]*)]\(([^)]+)\)|\[([^\]]+)]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  let mediaIndex = 0;
  while ((match = mediaPattern.exec(source))) {
    const label = (match[1] || match[3] || "内容").trim();
    const path = match[2] || match[4];
    const kind = mediaKind(path);
    if (kind === "image" || kind === "video" || kind === "audio" || path.startsWith("/")) {
      content.push({ id: `${id}:media:${mediaIndex++}`, role: "assistant", kind, label });
    }
  }
  return content;
}

type TranscriptLine = { role: "user" | "assistant"; text: string };
type RealtimeDelegation = { id: string; input: string | null; source: string | null; transcript: TranscriptLine[] };

function realtimeDelegation(item: ThreadItem): RealtimeDelegation | null {
  if (item.type !== "userMessage") return null;
  const blocks = Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : [];
  const source = blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .find((text) => text.includes("<realtime_delegation>"));
  if (!source) return null;
  const transcript = (extractTag(source, "transcript_delta") || "")
    .split(/\r?\n/)
    .flatMap((line): TranscriptLine[] => {
      const match = line.match(/^\s*(user|assistant)\s*:\s*(.+?)\s*$/i);
      if (!match?.[2]?.trim()) return [];
      return [{ role: match[1].toLowerCase() === "assistant" ? "assistant" : "user", text: match[2].trim() }];
    });
  return {
    id: String(item.id || crypto.randomUUID()),
    input: extractTag(source, "input"),
    source: extractTag(source, "source"),
    transcript,
  };
}

function normalizedSpeech(value: string) {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function sameSpeech(left: string, right: string) {
  const normalizedLeft = normalizedSpeech(left);
  const normalizedRight = normalizedSpeech(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  return Math.min(normalizedLeft.length, normalizedRight.length) >= 4
    && (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft));
}

function finalAssistantText(lines: TranscriptLine[]) {
  const assistantLines = lines.filter((line) => line.role === "assistant");
  return assistantLines
    .filter((line, index) => !assistantLines.slice(index + 1).some((later) => sameSpeech(line.text, later.text)))
    .map((line) => line.text)
    .join(" ")
    .trim();
}

function findLastLineIndex(lines: TranscriptLine[], predicate: (line: TranscriptLine, index: number) => boolean) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (predicate(lines[index], index)) return index;
  }
  return -1;
}

function threadVisibleContent(thread: ThreadDetail): Array<Omit<SessionContent, "order">> {
  const content: Array<Omit<SessionContent, "order">> = [];
  let previousInput: string | null = null;
  for (const turn of thread.turns || []) {
    for (const item of turn.items || []) {
      const delegation = realtimeDelegation(item);
      if (!delegation) {
        content.push(...visibleContent(item));
        continue;
      }

      if (previousInput) {
        const currentIsNew = Boolean(delegation.input && delegation.source !== "transcript_tail_flush" && !sameSpeech(delegation.input, previousInput));
        const currentBoundary = currentIsNew
          ? findLastLineIndex(delegation.transcript, (line) => line.role === "user" && sameSpeech(line.text, delegation.input!))
          : delegation.transcript.length;
        const boundary = currentBoundary >= 0 ? currentBoundary : delegation.transcript.length;
        const previousIndex = findLastLineIndex(delegation.transcript, (line, index) => (
          index < boundary && line.role === "user" && sameSpeech(line.text, previousInput!)
        ));
        if (previousIndex >= 0) {
          const assistantText = finalAssistantText(delegation.transcript.slice(previousIndex + 1, boundary));
          if (assistantText) {
            content.push({
              id: `${delegation.id}:transcript:assistant`,
              role: "assistant",
              kind: "text",
              text: assistantText,
            });
          }
        }
      }

      if (delegation.input && delegation.source !== "transcript_tail_flush" && (!previousInput || !sameSpeech(delegation.input, previousInput))) {
        content.push({
          id: `${delegation.id}:transcript:user`,
          role: "user",
          kind: "text",
          text: delegation.input,
        });
        previousInput = delegation.input;
      }
    }
  }
  return content;
}

function visibleContent(item: ThreadItem): Array<Omit<SessionContent, "order">> {
  const id = String(item.id || crypto.randomUUID());
  if (item.type === "userMessage") {
    const blocks = Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : [];
    const content: Array<Omit<SessionContent, "order">> = [];
    blocks.forEach((block, index) => {
      if (block.type !== "text" || typeof block.text !== "string") {
        content.push({ id: `${id}:${index}`, role: "user", kind: "unsupported", label: "暂不支持此内容" });
        return;
      }
      const text = extractTag(block.text, "input") || block.text.trim();
      if (text) content.push({ id: `${id}:${index}`, role: "user", kind: "text", text });
    });
    return content;
  }
  if (item.type === "agentMessage") return agentMediaContent(item);
  if (item.type === "imageGeneration") {
    return [{ id, role: "assistant", kind: "image", label: "暂不支持此内容" }];
  }
  return [];
}

export class CodexSessionContentMonitor {
  private reader: AppServerReader | null = null;
  private timer: NodeJS.Timeout | null = null;
  private selectedThreadId: string | null = null;
  private lastThreadUpdatedAt = 0;
  private seen = new Set<string>();
  private allContent: SessionContent[] = [];
  private stopped = false;

  constructor(private readonly onContent: (content: SessionContent) => void) {}

  async start() {
    this.reader = new AppServerReader();
    await this.reader.initialize();
    await this.poll(true);
    this.timer = setInterval(() => void this.poll(false).catch((error) => {
      if (!this.stopped) console.error(`Codex content polling failed: ${(error as Error).message}`);
    }), 1_500);
  }

  history(before?: string | null, limit = 20) {
    const requestedEnd = before ? Number(before) : this.allContent.length;
    const end = Number.isFinite(requestedEnd) ? Math.min(this.allContent.length, Math.max(0, requestedEnd)) : this.allContent.length;
    const start = Math.max(0, end - Math.min(50, Math.max(1, limit)));
    return {
      items: this.allContent.slice(start, end),
      nextCursor: start > 0 ? String(start) : null,
    };
  }

  private async listThreads() {
    const result = await this.reader!.request("thread/list", { limit: 20, sortKey: "updated_at" }) as { data?: ThreadSummary[] };
    return result.data || [];
  }

  private async readThread(threadId: string, includeTurns: boolean) {
    const result = await this.reader!.request("thread/read", { threadId, includeTurns }) as { thread?: ThreadDetail };
    return result.thread || null;
  }

  private async findRealtimeThread(summaries: ThreadSummary[]) {
    const delegated = summaries.find((thread) => thread.preview?.includes("<realtime_delegation>"));
    const selected = summaries.find((thread) => thread.id === this.selectedThreadId);
    if (delegated && (!selected || delegated.updatedAt > selected.updatedAt)) return delegated.id;
    if (selected) return selected.id;
    if (delegated) return delegated.id;
    for (const summary of summaries.slice(0, 12)) {
      const thread = await this.readThread(summary.id, true);
      if (thread?.threadSource === "realtime_voice") return thread.id;
    }
    return null;
  }

  private async poll(baseline: boolean) {
    if (!this.reader || this.stopped) return;
    const summaries = await this.listThreads();
    const threadId = await this.findRealtimeThread(summaries);
    if (!threadId) return;
    const summary = summaries.find((thread) => thread.id === threadId);
    if (!baseline && summary && summary.updatedAt <= this.lastThreadUpdatedAt) return;
    const thread = await this.readThread(threadId, true);
    if (!thread) return;
    if (this.selectedThreadId !== threadId) {
      this.selectedThreadId = threadId;
      console.log(`✓ 正在同步 GPT-Live 会话内容 (${threadId.slice(0, 8)})`);
    }
    const contents = threadVisibleContent(thread)
      .map((content, order) => ({ ...content, order }));
    this.allContent = contents;
    for (const content of contents) {
      if (baseline) this.seen.add(content.id);
      else if (!this.seen.has(content.id)) {
        this.seen.add(content.id);
        this.onContent(content);
      }
    }
    this.lastThreadUpdatedAt = summary?.updatedAt || Date.now();
  }

  async close() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.reader?.close();
    this.reader = null;
  }
}
