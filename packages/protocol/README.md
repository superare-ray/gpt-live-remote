# Protocol

The control protocol uses authenticated JSON messages over WSS. This package will become the generated TypeScript/Swift schema source after the control-loop prototype is validated.

Current message families:

- `bridge.hello`, `bridge.heartbeat`
- `control.ready`, `control.heartbeat`, `control.heartbeat.ack`, `control.error`
- `pairing.request`, `pairing.approve`, `pairing.reject`
- `session.start`, `session.ready`, `session.failed`, `session.stop`, `session.stopped`, `session.stop_failed`
- `session.text`
