import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type DesktopVoiceConfig = {
  bundleId: string;
  shortcutKey: string;
  shortcutModifiers: Set<"command" | "control" | "option" | "shift">;
  activePattern: RegExp;
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
  const shortcutKey = process.env.VOICE_SHORTCUT_KEY?.trim();
  const shortcutModifiers = process.env.VOICE_SHORTCUT_MODIFIERS?.split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean) ?? [];
  const allowedModifiers = new Set(["command", "control", "option", "shift"]);
  if (!shortcutKey) throw new Error("voice_shortcut_not_configured");
  if (shortcutModifiers.some((value) => !allowedModifiers.has(value))) {
    throw new Error("voice_shortcut_modifiers_invalid");
  }
  const activeMatch = process.env.VOICE_ACTIVE_AX_MATCH?.trim();
  if (!activeMatch) throw new Error("voice_state_probe_not_configured");
  let activePattern: RegExp;
  try {
    activePattern = new RegExp(activeMatch, "iu");
  } catch {
    throw new Error("voice_state_probe_pattern_invalid");
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
  set useCommand to item 3 of argv is "true"
  set useControl to item 4 of argv is "true"
  set useOption to item 5 of argv is "true"
  set useShift to item 6 of argv is "true"
  set modifiers to {}
  if useCommand then set end of modifiers to command down
  if useControl then set end of modifiers to control down
  if useOption then set end of modifiers to option down
  if useShift then set end of modifiers to shift down
  tell application "System Events"
    set targetProcess to first application process whose bundle identifier is appBundleId
    set frontmost of targetProcess to true
    delay 0.25
    if shortcutKey is "space" then
      keystroke " " using modifiers
    else
      keystroke shortcutKey using modifiers
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
    set allElements to entire contents of front window of targetProcess
    repeat with elementRef in allElements
      set rowText to ""
      repeat with attributeName in {"AXRole", "AXSubrole", "AXIdentifier", "AXTitle", "AXDescription", "AXValue", "AXHelp"}
        try
          set attributeValue to value of attribute (contents of attributeName) of elementRef
          if attributeValue is not missing value then set rowText to rowText & (contents of attributeName) & "=" & (attributeValue as text) & tab
        end try
      end repeat
      if rowText is not "" then set output to output & rowText & linefeed
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
  await execFileAsync("/usr/bin/osascript", [
    "-e",
    shortcutScript,
    config.bundleId,
    config.shortcutKey,
    String(config.shortcutModifiers.has("command")),
    String(config.shortcutModifiers.has("control")),
    String(config.shortcutModifiers.has("option")),
    String(config.shortcutModifiers.has("shift")),
  ]);
}

export async function startAndVerifyVoice(config: DesktopVoiceConfig) {
  const preflight = await desktopPreflight(config.bundleId);
  if (!preflight.appInstalled) throw new Error("chatgpt_app_not_found");
  if (!preflight.accessibilityEnabled) throw new Error("accessibility_permission_missing");

  await triggerShortcut(config);
  const deadline = Date.now() + config.timeoutMs;
  let consecutiveMatches = 0;
  while (Date.now() < deadline) {
    const snapshot = await readAccessibilitySnapshot(config.bundleId);
    consecutiveMatches = config.activePattern.test(snapshot) ? consecutiveMatches + 1 : 0;
    if (consecutiveMatches >= 2) return { verified: true, preflight };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("voice_ui_state_unverified");
}
