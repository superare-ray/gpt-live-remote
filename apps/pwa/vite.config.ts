import vinext from "vinext";
import { defineConfig } from "vite";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig({
    server: {
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
      proxy: {
        "/api": {
          target: process.env.CONTROL_API_PROXY ?? "http://127.0.0.1:8787",
          ws: true,
        },
      },
    },
    plugins: [vinext()],
});
