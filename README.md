# GPT-Live Remote

GPT-Live Remote lets a Huawei phone securely control and talk to GPT-Live running in the official ChatGPT Desktop app on a Mac.

The Mac remains the system of record for the ChatGPT account, GPT-Live intelligence, and Codex integration. This project does not use OpenAI API keys, cookies, or Codex task data.

## Project status

The project is currently validating the minimum control and audio loop:

1. Sign in to the mobile PWA.
2. Pair a Mac by scanning a one-time QR code.
3. See paired Macs and their online state.
4. Start a session without exposing an inbound port on the Mac.
5. Relay two-way audio through a self-hosted WebRTC media server.
6. Trigger and verify ChatGPT Desktop Voice mode.

The macOS bridge is intentionally run as a development process during the first connectivity tests. Packaging and notarization come after the end-to-end loop is proven.

## Repository layout

```text
apps/
  pwa/             Huawei-browser-friendly mobile PWA
  mac-bridge/      Unbundled macOS bridge prototype, later a signed app
services/
  control-api/     Authentication, pairing, devices, sessions, and WSS
packages/
  protocol/        Shared messages and schemas
infra/             Isolated deployment configuration
docs/              Architecture and implementation notes
UI Refs/           Approved mobile UI references
```

## Security boundaries

- The Mac initiates all server connections; it exposes no inbound port.
- Account authentication and Mac pairing are separate security layers.
- Pairing codes and login codes are one-time and short-lived.
- Long-lived secrets are never committed to this repository.
- Media is not recorded by the MVP.

See [the implementation plan](docs/IMPLEMENTATION_PLAN.md) for the detailed architecture and rollout sequence.

## Local control-loop test

Prerequisites: Node.js 22 or newer.

1. Copy `services/control-api/.env.example` to an ignored `.env` file and set development secrets.
2. Run `npm install && npm run dev` in `services/control-api`.
3. Run `npm install && npm run dev` in `apps/pwa`.
4. Create an ignored `.bridge-token`, then run the Mac bridge with `CONTROL_API_BASE`, `BRIDGE_TOKEN_FILE`, and an optional `BRIDGE_CONFIG_PATH`.

The first public test validates authentication, explicit device pairing, device presence, session start, push-to-talk state, and text-event delivery. It does not yet relay audio or automate ChatGPT Desktop Voice.

## License

MIT
