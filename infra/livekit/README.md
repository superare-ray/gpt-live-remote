# LiveKit media relay (additive test deployment)

This directory adds a standalone LiveKit SFU without replacing the existing control API, PWA, or unrelated server services.

## First test ports

- `9443/TCP` remains the existing HTTPS/WSS entry point. Nginx will proxy LiveKit signaling at `/rtc` to `127.0.0.1:7880`.
- `7881/TCP` is LiveKit ICE/TCP fallback.
- `7882/UDP` is LiveKit's single-port ICE/UDP mux.

Do not expose the internal API port `7880` in the Alibaba Cloud security group.

## Secrets

Copy `.env.example` to an ignored `.env` file and replace both values. The same API key and secret are supplied to the control API so it can mint short-lived, room-scoped participant tokens. Never commit the real values.

## Production follow-up

The reduced-port setup is for the first audio loop. Production should add a real domain, a publicly trusted TLS certificate, and TURN/TLS or coturn for restrictive mobile networks.
