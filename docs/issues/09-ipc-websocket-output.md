# Issue 09 — WebSocket Output Interface

**Type:** AFK
**Blocked by:** Issue 07 (real-time transcript events flowing)
**Priority:** Integration enabler

---

## Description

Expose the real-time transcript stream (and AI question events, once available) over a local WebSocket server running inside the Electron main process. This enables any external consumer — a browser extension, a mobile companion app, a REST bridge, or a development client — to subscribe to the live session without being coupled to Electron IPC internals.

The named pipe / Unix socket connection between the sidecar and Electron main process (established in earlier slices) is unchanged. This slice adds a second output layer on top of it.

---

## Architecture

```
Sidecar (C++)
  └── JSONL over named pipe / Unix socket
        └── Electron main process
              ├── Electron IPC → renderer (existing)
              └── WebSocket server (ws://) ← NEW
                    └── any external subscriber
```

The WebSocket server listens on `127.0.0.1` only — never `0.0.0.0`. It is not accessible from other machines on the network.

---

## Event Schema

All messages are JSON. The server sends; clients only receive (read-only output in v1).

```typescript
// Transcript event
{
  "event": "transcript",
  "sessionId": "uuid-v4",
  "type": "partial" | "final",
  "text": "The meeting will start at 3pm.",
  "startMs": 1200,
  "endMs": 4800,
  "segments": [
    { "startMs": 1200, "endMs": 2800, "text": "The meeting will start" },
    { "startMs": 2800, "endMs": 4800, "text": "at 3pm." }
  ]
}

// Session lifecycle events
{ "event": "session:started", "sessionId": "uuid-v4", "role": "interviewer", "startedAt": 1743676800000 }
{ "event": "session:stopped", "sessionId": "uuid-v4", "stoppedAt": 1743676900000 }

// AI question event (no-op for now — emitted when AIModule fires 'questions')
{ "event": "questions", "sessionId": "uuid-v4", "questions": [] }

// Error event
{ "event": "error", "code": "DEVICE_LOST" | "PERMISSION_DENIED" | "EXCLUSIVE_MODE", "message": "..." }

// Heartbeat (sent every 5 seconds to detect stale connections)
{ "event": "ping", "ts": 1743676800000 }
```

---

## Server Implementation

```typescript
// src/ipc/WebSocketOutputServer.ts
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';

export class WebSocketOutputServer {
  private wss: WebSocketServer;
  private clients = new Set<WebSocket>();

  constructor(private readonly port: number = 49152) {
    this.wss = new WebSocketServer({ host: '127.0.0.1', port });
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
    });
  }

  broadcast(event: object): void {
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  close(): void {
    this.wss.close();
  }
}
```

### Port Selection
Default port: `49152` (first of the dynamic/private range). If the port is taken, increment until a free port is found. Write the resolved port to a lock file (`~/.aura/ws.port`) so external consumers can discover it.

```typescript
// ~/.aura/ws.port contains a single line: the resolved port number
// External consumers read this file to know where to connect
```

---

## Security Considerations

- Bind to `127.0.0.1` only — no remote access
- No authentication in v1 (local-only, same-machine consumers)
- If future versions allow remote connections, add a token-based handshake
- Do not log transcript content to the console — only connection/disconnection events

---

## Tasks

- [ ] Add `ws` package: `npm install ws` and `npm install --save-dev @types/ws`
- [ ] Implement `src/ipc/WebSocketOutputServer.ts`
  - [ ] Bind to `127.0.0.1:49152` with port auto-increment on conflict
  - [ ] Write resolved port to `~/.aura/ws.port` on startup
  - [ ] Delete `~/.aura/ws.port` on shutdown
  - [ ] Broadcast `ping` heartbeat every 5 seconds
  - [ ] Remove stale clients that fail to receive a heartbeat
- [ ] Wire `WebSocketOutputServer` into `SessionOrchestrator`:
  - [ ] `session:started` on `startSession()`
  - [ ] `transcript` on each sidecar message
  - [ ] `questions` on each AI module `questions` event
  - [ ] `error` on sidecar error events
  - [ ] `session:stopped` on `stopSession()`
- [ ] Add port display to the renderer settings panel ("WebSocket output: ws://127.0.0.1:49152")
- [ ] Write an integration test: connect a WebSocket client, start a mock session, assert `session:started` and `transcript` events are received in order
- [ ] Document the event schema in `docs/API.md`

---

## Acceptance Criteria

- `WebSocketOutputServer` starts on app launch and stops on app quit
- A `wscat` or `websocat` client connecting to `ws://127.0.0.1:<port>` receives live transcript events during a session
- Port is written to `~/.aura/ws.port` and external consumers can read it
- Server binds to `127.0.0.1` only — connection from a remote IP is rejected
- Disconnected clients are pruned from the client set — no broadcast to dead sockets
- Integration test passes on both macOS and Windows CI runners
- Event schema is documented in `docs/API.md`
