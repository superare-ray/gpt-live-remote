# Security policy

GPT-Live Remote is an early connectivity prototype. Do not expose a development deployment as a general-purpose public service.

## Reporting a vulnerability

Please open a private security advisory in this repository instead of a public issue.

## Secrets

- Never commit server passwords, enrollment tokens, device credentials, cookies, certificates, or private keys.
- Rotate `COOKIE_SECRET`, `BRIDGE_ENROLLMENT_TOKEN`, and any demo login code after a test.
- Device secrets are sent in an authorization header, never in a URL.
- Pairing requires both a short-lived code and explicit approval on the Mac.

## Current prototype limitations

- Email delivery is not yet connected; test deployments use a temporary server-side demo code.
- The media relay and ChatGPT Desktop Voice automation are not part of the first control-loop deployment.
- Production deployment requires a real email provider, persistent rate limiting, monitoring, backups, and a security review.
