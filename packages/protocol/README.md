# Protocol

The control protocol uses authenticated JSON messages over WSS. This package will become the generated TypeScript/Swift schema source after the control-loop prototype is validated.

Current message families:

- `bridge.hello`, `bridge.heartbeat`
- `pairing.request`, `pairing.approve`, `pairing.reject`
- `session.start`, `session.ready`, `session.failed`
- `session.ptt`, `session.text`
