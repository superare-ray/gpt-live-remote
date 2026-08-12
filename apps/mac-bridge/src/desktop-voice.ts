import { execFile } from "node:child_process";
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
    timeoutMs: Number(process.env.VOICE_STATE_TIMEOUT_MS || 8_000),
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

const shortcutScript = String.raw`
on run argv
  set appBundleId to item 1 of argv
  set shortcutKey to item 2 of argv
  tell application "System Events"
    set targetProcess to first application process whose bundle identifier is appBundleId
    set frontmost of targetProcess to true
    delay 0.25
    if shortcutKey is "space" then
      keystroke " " using {__MODIFIERS__}
    else
      keystroke shortcutKey using {__MODIFIERS__}
    end if
  end tell
end run
`;

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
  await execFileAsync("/usr/bin/open", ["-b", config.bundleId]);
  const modifiers = ["command", "control", "option", "shift"]
    .filter((modifier) => config.shortcutModifiers.has(modifier as "command" | "control" | "option" | "shift"))
    .map((modifier) => `${modifier} down`)
    .join(", ");
  await execFileAsync("/usr/bin/osascript", [
    "-e",
    shortcutScript.replaceAll("__MODIFIERS__", modifiers),
    config.bundleId,
    config.shortcutKey,
  ]);
}

export async function startAndVerifyVoice(config: DesktopVoiceConfig) {
  const preflight = await desktopPreflight(config.bundleId);
  if (!preflight.appInstalled) throw new Error("chatgpt_app_not_found");
  if (!preflight.accessibilityEnabled) throw new Error("accessibility_permission_missing");

  if (config.activePattern) {
    const currentSnapshot = await readAccessibilitySnapshot(config.bundleId);
    if (config.activePattern.test(currentSnapshot)) {
      // A Voice window left over from an earlier remote session can retain the
      // old CoreAudio devices. Close it first so the next start reacquires the
      // BlackHole defaults selected by the media bridge.
      await triggerShortcut(config);
      const stopDeadline = Date.now() + config.timeoutMs;
      let consecutiveStops = 0;
      while (Date.now() < stopDeadline) {
        const snapshot = await readAccessibilitySnapshot(config.bundleId);
        consecutiveStops = config.activePattern.test(snapshot) ? 0 : consecutiveStops + 1;
        if (consecutiveStops >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (consecutiveStops < 2) throw new Error("voice_ui_stop_unverified");
    }
  }
  await triggerShortcut(config);
  const deadline = Date.now() + config.timeoutMs;
  if (!config.activePattern) {
    // Electron currently exposes Voice state inside its renderer rather than the
    // native AX tree. We can still verify the app's audio service transition.
    while (Date.now() < deadline) {
      const { stdout } = await execFileAsync("/usr/bin/pgrep", ["-f", "utility-sub-type=audio.mojom.AudioService"]).catch(() => ({ stdout: "", stderr: "" }));
      if (stdout.trim()) return { verified: true, preflight };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("voice_audio_service_unverified");
  }
  let consecutiveMatches = 0;
  while (Date.now() < deadline) {
    const snapshot = await readAccessibilitySnapshot(config.bundleId);
    consecutiveMatches = config.activePattern.test(snapshot) ? consecutiveMatches + 1 : 0;
    if (consecutiveMatches >= 2) return { verified: true, preflight };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("voice_ui_state_unverified");
}
