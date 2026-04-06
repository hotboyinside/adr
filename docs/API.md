# Verbatim — WebSocket Output API

## Overview

Verbatim exposes a read-only WebSocket server on `127.0.0.1` for external consumers to subscribe to live transcript and session events. The server is local-only and is not accessible from other machines.

## Connection

```
ws://127.0.0.1:<port>
```

The resolved port is written to `~/.verbatim/ws.port` at startup and deleted at shutdown. Read that file to discover the port:

```bash
# macOS / Linux
PORT=$(cat ~/.verbatim/ws.port)
websocat ws://127.0.0.1:$PORT

# Windows PowerShell
$port = Get-Content "$env:USERPROFILE\.verbatim\ws.port"
```

The default starting port is `49152`. If that port is occupied, Verbatim increments until a free port is found (max range: 49152–49201).

## Protocol

- The server sends JSON messages; clients are read-only in v1.
- A `ping` heartbeat is sent every 5 seconds to detect stale connections.
- All transcript and session messages share a `sessionId` (UUID v4) that is generated when a session starts and remains stable until the session ends.

---

## Event Reference

### `transcript`

Emitted for each speech utterance recognised by Whisper.

```json
{
  "event": "transcript",
  "sessionId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "type": "partial" | "final",
  "text": "The meeting will start at 3pm.",
  "startMs": 1200,
  "endMs": 4800,
  "segments": [
    { "startMs": 1200, "endMs": 2800, "text": "The meeting will start" },
    { "startMs": 2800, "endMs": 4800, "text": "at 3pm." }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `type` | `"partial"` \| `"final"` | `partial` events update in-place; `final` events are committed |
| `startMs` | number | Milliseconds from session start of utterance begin |
| `endMs` | number | Milliseconds from session start of utterance end (`0` for partials) |
| `segments` | array | Word-level segments (empty array in v1) |

---

### `session:started`

Emitted when the user starts a capture session.

```json
{
  "event": "session:started",
  "sessionId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "role": "interviewer",
  "startedAt": 1743676800000
}
```

| Field | Type | Description |
|---|---|---|
| `role` | string | Session role: `default` \| `interviewer` \| `customer` \| `presenter` |
| `startedAt` | number | Unix timestamp (ms) when the session started |

---

### `session:stopped`

Emitted when the user stops a capture session.

```json
{
  "event": "session:stopped",
  "sessionId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "stoppedAt": 1743676900000
}
```

---

### `questions`

Emitted when the AI module generates follow-up questions. In v1 (NoOpAIModule) this event is never emitted.

```json
{
  "event": "questions",
  "sessionId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "questions": [
    { "text": "Can you elaborate on the timeline?", "confidence": 0.87 }
  ]
}
```

---

### `error`

Emitted when the audio capture pipeline encounters an unrecoverable error.

```json
{
  "event": "error",
  "code": "DEVICE_LOST",
  "message": "Audio device disconnected"
}
```

| `code` | Meaning |
|---|---|
| `DEVICE_LOST` | Audio capture device was unplugged or became unavailable |
| `PERMISSION_DENIED` | Screen recording / microphone permission was revoked |
| `EXCLUSIVE_MODE` | Another app has exclusive control of the audio device (Windows) |

---

### `ping`

Sent every 5 seconds. Clients can use this to detect connection health.

```json
{ "event": "ping", "ts": 1743676800000 }
```

---

## Quick-start with `websocat`

```bash
# Install
brew install websocat           # macOS
cargo install websocat          # any platform

# Connect
PORT=$(cat ~/.verbatim/ws.port)
websocat ws://127.0.0.1:$PORT
```

## Quick-start with `wscat`

```bash
npm install -g wscat
PORT=$(cat ~/.verbatim/ws.port)
wscat -c ws://127.0.0.1:$PORT
```
