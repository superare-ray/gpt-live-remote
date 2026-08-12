# Design QA

- Source visual truth: `/var/folders/gk/m7lzdn7s2dxd1qjs_f_j4b5h0000gn/T/codex-clipboard-2819e5f3-2c36-4acc-8688-391e25ef4f04.jpg`
- Source pixels: 949 × 2048 (browser chrome included)
- Implementation: `https://8.137.116.27:9443/gpt-live-remote`
- Intended viewport: 390 × 844 CSS px, DPR 1
- State: authenticated Live voice session
- Density normalization: not completed because the rendered implementation could not be captured

## Full-view comparison evidence

The source screenshot was available. The deployed implementation could not be captured: both the connected Chrome preview and the in-app preview timed out while navigating to the TLS endpoint. Server health and the production build were verified separately, but code inspection is not accepted as visual evidence.

## Focused region comparison evidence

Blocked with the full-view capture. The required header controls, live waveform, circular PTT control, and connected-device state could not be compared visually.

## Findings

- P1: Browser-rendered evidence is missing, so responsive layout and visual polish cannot be signed off.
- P1: Real microphone permission, waveform response, GPT reply playback, and disconnect interaction require a real mobile-browser session.

## Comparison history

- Pass 1: source visual opened; implementation capture timed out in the connected Chrome preview.
- Pass 2: switched to the in-app preview; navigation to the deployed TLS endpoint also timed out.
- Code/build fixes completed before capture: compact header, smaller icon-only refresh control, circular PTT control, real analyser-driven three-dot waveform, standard Web Audio playback, connected/disconnect device states, and global pressed feedback.

## Implementation checklist

- Open the deployed URL on the phone and refresh once.
- Confirm device name and icon.
- Connect, hold PTT, observe the three real audio-level bars, hear the reply, then disconnect.
- Capture the Live screen at the same state for the final visual comparison.

final result: blocked
