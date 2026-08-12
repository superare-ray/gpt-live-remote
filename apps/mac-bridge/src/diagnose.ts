import { desktopPreflight, readAccessibilitySnapshot } from "./desktop-voice.js";

const bundleId = process.env.CHATGPT_BUNDLE_ID?.trim() || "com.openai.chat";
const result = await desktopPreflight(bundleId);

console.log("GPT-Live Remote Bridge diagnostics");
console.log(`bundle id: ${bundleId}`);
console.log(`app installed: ${result.appInstalled ? "yes" : "no"}`);
console.log(`app running: ${result.appRunning ? "yes" : "no"}`);
console.log(`Accessibility: ${result.accessibilityEnabled ? "enabled" : "missing"}`);
console.log(`app path: ${result.appPath || "not found"}`);

if (result.appRunning && result.accessibilityEnabled) {
  const snapshot = await readAccessibilitySnapshot(bundleId);
  console.log("\nAccessibility snapshot (no chat content is uploaded):\n");
  console.log(snapshot || "No accessible Voice UI elements were exposed.");
}
