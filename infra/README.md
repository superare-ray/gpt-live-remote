# Infrastructure

The control-loop prototype is intentionally isolated from existing server workloads:

- Control API: `127.0.0.1:8787`
- PWA runtime: `127.0.0.1:8790`
- Dedicated HTTPS entry point: `9443`

Only the dedicated Nginx server block is public. Existing Nginx sites and containers are not modified by the compose file.

LiveKit and TURN are deliberately excluded from this first deployment because the target ECS currently has limited memory. Add the media plane only after the control loop is validated and the instance is upgraded or a media instance is added.
