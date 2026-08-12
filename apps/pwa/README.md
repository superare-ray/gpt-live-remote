# GPT-Live Remote PWA

Mobile web client for authentication, Mac pairing, device selection, control-session startup, push-to-talk state, and text events.

## Development

Requires Node.js 22.13 or newer and a running control API on `127.0.0.1:8787`.

```bash
npm install
npm run dev
```

Set `CONTROL_API_PROXY` when the API runs elsewhere. Production uses same-origin `/api` routes through Nginx.

## Checks

```bash
npm test
```

This runs ESLint and a production Vinext build.
