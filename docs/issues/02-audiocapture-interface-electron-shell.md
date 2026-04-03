# Issue 02 — AudioCapture Interface + Electron Shell Skeleton

**Type:** AFK
**Blocked by:** Issue 01
**Priority:** Critical path

---

## Description

Establish the cross-platform foundation that all subsequent slices build on. This slice produces two things:

1. **The `AudioCapture` TypeScript interface** — the contract every platform implementation (macOS, Windows, Linux) must conform to. Defined once here, never changed without a new ADR.
2. **The Electron shell skeleton** — a runnable Electron app with a main process, a minimal renderer, a system tray icon, and the sidecar process manager wired up (but not yet launching a real sidecar).

No actual audio capture is implemented here. Slices 03a and 03b implement the interface.

---

## Interface Definition

```typescript
// src/capture/AudioCapture.ts

export interface AudioCaptureOptions {
  sampleRate: 16000 | 44100 | 48000;
  channels: 1 | 2;
  bitDepth: 16 | 32;
}

export interface AudioChunk {
  pcm: Buffer;          // raw PCM samples
  capturedAt: number;   // Unix timestamp ms
  sampleRate: number;
  channels: number;
  bitDepth: number;
}

export interface AudioCapture {
  start(options: AudioCaptureOptions): Promise<void>;
  stop(): Promise<void>;
  on(event: 'data', listener: (chunk: AudioChunk) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'stopped', listener: () => void): this;
}
```

---

## Sidecar Process Manager Interface

```typescript
// src/sidecar/SidecarManager.ts

export type SidecarMessage =
  | { type: 'partial' | 'final'; text: string; startMs: number; endMs: number }
  | { type: 'status'; value: 'capturing' | 'idle' | 'paused' }
  | { type: 'error'; code: string; message: string };

export interface SidecarManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(command: string): void;
  on(event: 'message', listener: (msg: SidecarMessage) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
}
```

---

## Project Structure to Establish

```
/
├── electron/
│   ├── main.ts           # Electron main process entry
│   ├── preload.ts        # Context bridge
│   └── tray.ts           # System tray setup
├── src/
│   ├── capture/
│   │   └── AudioCapture.ts       # Interface definition
│   ├── sidecar/
│   │   └── SidecarManager.ts     # Interface + stub implementation
│   ├── ai/
│   │   └── AIModule.ts           # Interface (from ADR)
│   └── session/
│       └── SessionState.ts       # Session state type
├── sidecar/                      # C++ sidecar source (empty placeholder)
│   └── CMakeLists.txt
├── renderer/                     # React UI
│   └── App.tsx
├── package.json
├── tsconfig.json
└── electron-builder.config.js
```

---

## Tasks

- [ ] Initialise Electron + TypeScript project (`electron-forge` or `electron-builder`)
- [ ] Define `AudioCapture`, `AudioChunk`, `AudioCaptureOptions` interfaces in `src/capture/AudioCapture.ts`
- [ ] Define `SidecarManager` interface and a `MockSidecarManager` stub that emits fake transcript events every 2 seconds (used for UI development without a real sidecar)
- [ ] Define `AIModule` interface and no-op stub in `src/ai/AIModule.ts`
- [ ] Define `SessionState` type in `src/session/SessionState.ts`
- [ ] Implement `electron/main.ts`: app lifecycle, IPC channels, sidecar manager wiring
- [ ] Implement `electron/tray.ts`: system tray icon with Start / Stop / Quit menu items
- [ ] Implement `electron/preload.ts`: expose `startCapture`, `stopCapture`, `onTranscript` to renderer via context bridge
- [ ] Implement `renderer/App.tsx`: minimal UI showing a status badge and a scrollable transcript list (populated via `onTranscript`)
- [ ] Add `sidecar/CMakeLists.txt` as an empty placeholder with a comment pointing to Slices 03a/03b
- [ ] Configure `electron-builder` for macOS (`.dmg`) and Windows (`.exe` NSIS installer) targets
- [ ] Confirm app launches, tray icon appears, and mock transcript events appear in the renderer

---

## Acceptance Criteria

- `npm run dev` launches the Electron app on both macOS and Windows
- System tray icon is present with functional Start / Stop / Quit actions
- Renderer displays rolling fake transcript lines emitted by `MockSidecarManager`
- `AudioCapture`, `SidecarManager`, and `AIModule` interfaces are committed and stable — no changes expected in subsequent slices without a new ADR
- TypeScript compiles with zero errors (`strict: true`)
