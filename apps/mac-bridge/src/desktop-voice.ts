import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type DesktopVoiceConfig = {
  bundleId: string;
  shortcutKey: string;
  shortcutModifiers: Set<"command" | "control" | "option" | "shift">;
  activePattern: RegExp | null;
  timeoutMs: number;
};

export type DesktopPreflight = {
  appInstalled: boolean;
  appRunning: boolean;
  accessibilityEnabled: boolean;
  appPath: string | null;
};

function parseBoolean(value: string) {
  return value.trim().toLowerCase() === "true";
}

export function desktopVoiceConfigFromEnv(): DesktopVoiceConfig {
  const shortcutKey = process.env.VOICE_SHORTCUT_KEY?.trim() || "v";
  const shortcutModifiers = process.env.VOICE_SHORTCUT_MODIFIERS?.split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean) ?? [];
  const allowedModifiers = new Set(["command", "control", "option", "shift"]);
  if (shortcutModifiers.some((value) => !allowedModifiers.has(value))) {
    throw new Error("voice_shortcut_modifiers_invalid");
  }
  const activeMatch = process.env.VOICE_ACTIVE_AX_MATCH?.trim() || "Codex Pet Voice Controls|Voice Controls Glass";
  let activePattern: RegExp | null = null;
  if (activeMatch) {
    try {
      activePattern = new RegExp(activeMatch, "iu");
    } catch {
      throw new Error("voice_state_probe_pattern_invalid");
    }
  }
  return {
    bundleId: process.env.CHATGPT_BUNDLE_ID?.trim() || "com.openai.chat",
    shortcutKey,
    shortcutModifiers: new Set(shortcutModifiers as Array<"command" | "control" | "option" | "shift">),
    activePattern,
    timeoutMs: Number(process.env.VOICE_STATE_TIMEOUT_MS || 12_000),
  };
}

export async function desktopPreflight(bundleId: string): Promise<DesktopPreflight> {
  if (process.platform !== "darwin") {
    return { appInstalled: false, appRunning: false, accessibilityEnabled: false, appPath: null };
  }
  const runningScript = "on run argv\ntell application \"System Events\" to return exists first application process whose bundle identifier is item 1 of argv\nend run";
  const [{ stdout: appPaths }, { stdout: appRunning }, { stdout: accessibility }] = await Promise.all([
    execFileAsync("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${bundleId}'`]),
    execFileAsync("/usr/bin/osascript", ["-e", runningScript, bundleId]),
    execFileAsync("/usr/bin/osascript", ["-e", "tell application \"System Events\" to return UI elements enabled"]),
  ]);
  const appPath = appPaths.split("\n").find((path) => path.endsWith(".app")) || null;
  return {
    appInstalled: appPath !== null,
    appRunning: parseBoolean(appRunning),
    accessibilityEnabled: parseBoolean(accessibility),
    appPath,
  };
}

const snapshotScript = String.raw`
on run argv
  set appBundleId to item 1 of argv
  tell application "System Events"
    if not (exists first application process whose bundle identifier is appBundleId) then return ""
    set targetProcess to first application process whose bundle identifier is appBundleId
    if (count of windows of targetProcess) is 0 then return ""
    set output to ""
    repeat with windowRef in windows of targetProcess
      try
        set output to output & "AXWindowTitle=" & (name of windowRef as text) & linefeed
      end try
    end repeat
    return output
  end tell
end run
`;

export async function readAccessibilitySnapshot(bundleId: string) {
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", snapshotScript, bundleId], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

async function triggerShortcut(config: DesktopVoiceConfig) {
  // The realtimeVoice command is OS-global. Keep the user's current Codex
  // surface intact instead of activating or navigating the app window.
  await execFileAsync("/usr/bin/open", ["-g", "-b", config.bundleId]);
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "../native/audio-device.swift");
  const modifiers = ["command", "control", "option", "shift"]
    .filter((modifier) => config.shortcutModifiers.has(modifier as "command" | "control" | "option" | "shift"))
    .join(", ");
  // Electron's global shortcut handler does not reliably receive AppleScript
  // `keystroke` events. Post the physical key code through CoreGraphics.
  await execFileAsync("/usr/bin/swift", [script, "send-hotkey", config.shortcutKey, modifiers]);
}

type AudioProcessState = { input: boolean; output: boolean; pids: number[] };

async function readAudioProcessState(bundleId: string): Promise<AudioProcessState> {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "../native/audio-device.swift");
  const { stdout } = await execFileAsync("/usr/bin/swift", [script, "process-io", bundleId]);
  return JSON.parse(stdout) as AudioProcessState;
}

async function waitForVoiceInput(config: DesktopVoiceConfig, expected: boolean) {
  const deadline = Date.now() + config.timeoutMs;
  let consecutiveMatches = 0;
  let lastState: AudioProcessState = { input: false, output: false, pids: [] };
  while (Date.now() < deadline) {
    lastState = await readAudioProcessState(config.bundleId);
    consecutiveMatches = lastState.input === expected ? consecutiveMatches + 1 : 0;
    if (consecutiveMatches >= 2) return lastState;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(expected ? "voice_audio_input_unverified" : "voice_audio_stop_unverified");
}

async function restartDesktopAudioService(appPath: string | null) {
  if (!appPath) return [];
  const { stdout } = await execFileAsync("/usr/bin/pgrep", ["-f", "utility-sub-type=audio.mojom.AudioService"])
    .catch(() => ({ stdout: "", stderr: "" }));
  const restarted: number[] = [];
  for (const value of stdout.split("\n")) {
    const pid = Number(value.trim());
    if (!Number.isInteger(pid) || pid <= 1) continue;
    const { stdout: command } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "command="])
      .catch(() => ({ stdout: "", stderr: "" }));
    if (!command.includes(`${appPath}/Contents/Frameworks/`) || !command.includes("audio.mojom.AudioService")) continue;
    process.kill(pid, "SIGTERM");
    restarted.push(pid);
  }
  const deadline = Date.now() + 4_000;
  while (restarted.length && Date.now() < deadline) {
    const alive = restarted.some((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (!alive) return restarted;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return restarted;
}

export async function startAndVerifyVoice(config: DesktopVoiceConfig) {
  const preflight = await desktopPreflight(config.bundleId);
  if (!preflight.appInstalled) throw new Error("chatgpt_app_not_found");
  if (!preflight.accessibilityEnabled) throw new Error("accessibility_permission_missing");

  const currentAudio = await readAudioProcessState(config.bundleId);
  if (currentAudio.input) {
    // Voice is already active on this Mac. Device switching is a phone-side
    // routing operation and must not toggle an existing desktop Voice session.
    return { verified: true, preflight, audio: currentAudio, alreadyActive: true };
  }
  // Chromium's audio utility process can retain the device selected before the
  // Bridge changed the system default. Recreate only that helper (not the app)
  // so the next Voice input stream binds to the current BlackHole default.
  await restartDesktopAudioService(preflight.appPath);
  await triggerShortcut(config);
  const audio = await waitForVoiceInput(config, true);
  return { verified: true, preflight, audio };
}

export async function stopAndVerifyVoice(config: DesktopVoiceConfig) {
  const currentAudio = await readAudioProcessState(config.bundleId);
  if (!currentAudio.input) return { verified: true, audio: currentAudio };
  await triggerShortcut(config);
  const audio = await waitForVoiceInput(config, false);
  return { verified: true, audio };
}
