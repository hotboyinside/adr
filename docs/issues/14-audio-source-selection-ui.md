# Issue 14 — Audio Source Selection UI

**Type:** AFK
**Blocked by:** Issue 13 (microphone capture + permissions)
**Priority:** Critical path

---

## Description

Let the user choose which audio source to transcribe: system audio, microphone, or both. This slice adds a source picker to the renderer and tray menu, a microphone device dropdown, and a live input level indicator. When "Both" is selected, the two capture streams are mixed before entering the Normalizer.

No changes to the pipeline (Normalizer → VAD → Whisper) are required — this slice only controls which `AudioCapture` implementation(s) feed into it.

---

## Audio Source Modes

```typescript
type AudioSource = 'system' | 'microphone' | 'both';
```

| Mode | Behaviour |
|---|---|
| `system` | `MacOSAudioCapture` / `WindowsAudioCapture` only (existing) |
| `microphone` | `MacOSMicCapture` / `WindowsMicCapture` only (Issue 13) |
| `both` | Both capture instances run concurrently; chunks are interleaved into a single pipeline queue |

"Both" mode does not require audio mixing at the PCM level — each source emits `AudioChunk` objects independently and they share the same `StreamingPipeline` queue. The VAD treats them as a single stream, which is correct: Whisper transcribes whatever speech arrives, regardless of source.

---

## UI Changes

### Source Picker (Renderer)

Displayed in the session setup area, before the user starts a session:

```
Audio source
  ○ System audio
  ● Microphone
  ○ Both
```

Selecting `Microphone` or `Both` reveals the device dropdown below.

### Microphone Device Dropdown

```
Microphone
  ┌─────────────────────────────────────┐
  │ ✓ MacBook Pro Microphone (default)  │
  │   Rode NT-USB                       │
  │   AirPods Pro                       │
  └─────────────────────────────────────┘
```

Populated via `getMicrophoneDevices()` IPC call (Issue 13). Refreshed when the user opens the dropdown. The selected device ID is passed to `startSession()`.

### Input Level Indicator

A compact VU bar shown next to the source picker while a session is active. Driven by RMS amplitude of incoming `AudioChunk` PCM data, computed in the Electron main process and sent to the renderer via IPC at ~10 Hz.

```
Mic  ████████░░░░░░░░░░  -18 dBFS
```

Only shown when the active source includes `microphone`.

### Tray Menu Update

```
Aura
  ─────────────────
  Source: Microphone ▶  System Audio
                        Microphone   ✓
                        Both
  ─────────────────
  Stop Session
  Quit
```

The source submenu mirrors the renderer picker and stays in sync with it via IPC.

---

## Session Orchestrator Changes

```typescript
// src/session/SessionOrchestrator.ts — additions

startSession(context: SessionContext, source: AudioSource, micDeviceId?: string): void {
  if (source === 'system' || source === 'both') {
    this.systemCapture.start(captureOptions);
  }
  if (source === 'microphone' || source === 'both') {
    this.micCapture.start({ ...captureOptions, deviceId: micDeviceId });
  }
  this.ai.onSessionStart(context);
  this.sidecar.send('start');
}
```

`SessionContext` gains an optional `audioSource` field so the AI module (and WebSocket consumers) know what was captured:

```typescript
interface SessionContext {
  role: 'interviewer' | 'customer' | 'presenter' | 'default';
  audioSource: AudioSource;   // new
  domain?: string;
  participantCount?: number;
}
```

---

## IPC Surface

```typescript
// Additions to electron/preload.ts

getAudioSource(): Promise<AudioSource>
setAudioSource(source: AudioSource): Promise<void>

getMicrophoneDevices(): Promise<MicDevice[]>   // already added in Issue 13
getSelectedMicDevice(): Promise<string>        // returns device ID
setSelectedMicDevice(id: string): Promise<void>

getMicInputLevel(): void  // push-based — renderer listens via onMicLevel()
onMicLevel(listener: (rmsDb: number) => void): void
```

Persist `audioSource` and `selectedMicDeviceId` to `settings.json` so the user's last choice is restored on next launch.

---

## Tasks

### Renderer
- [ ] Add `AudioSourcePicker` component: radio group (System Audio / Microphone / Both)
- [ ] Add `MicDeviceDropdown` component: populated via `getMicrophoneDevices()`, shown when source includes microphone
- [ ] Add `MicLevelIndicator` component: VU bar driven by `onMicLevel()` IPC events
- [ ] Integrate all three into the session setup panel in `renderer/App.tsx`
- [ ] Disable "Start" button if source includes microphone and permission is not `granted`

### Electron Main Process
- [ ] Extend `startSession()` IPC handler to accept `source` and `micDeviceId` parameters
- [ ] Start the correct capture instance(s) based on `source` in `SessionOrchestrator`
- [ ] Implement RMS level computation from `AudioChunk` PCM data; emit to renderer at ~10 Hz via `mainWindow.webContents.send('mic:level', rmsDb)`
- [ ] Add `getAudioSource` / `setAudioSource` / `getSelectedMicDevice` / `setSelectedMicDevice` IPC handlers
- [ ] Persist `audioSource` and `selectedMicDeviceId` to `settings.json`
- [ ] Add source submenu to tray icon; keep in sync with renderer state

### Both Platforms
- [ ] Pass `audioSource` field in `SessionContext` to `AIModule.onSessionStart()` and WebSocket `session:started` event
- [ ] Write unit tests for `AudioSourcePicker`:
  - Microphone dropdown is hidden when source is `system`
  - Microphone dropdown is visible when source is `microphone` or `both`
  - Start button is disabled when source includes microphone and permission is `denied`
- [ ] Write an integration test: select `both`, start a session, assert chunks are received from both capture instances

---

## Acceptance Criteria

- User can switch between System Audio / Microphone / Both from both the renderer and the tray menu; selection persists across app restarts
- Microphone device dropdown lists all active input devices and the correct device is used when a session starts
- Mic level indicator updates in real time while a session with microphone source is active; not shown for system-audio-only sessions
- In "Both" mode, speech from either source is transcribed — verified manually by playing audio through speakers and speaking simultaneously
- `audioSource` is included in the WebSocket `session:started` event and in `SessionContext` passed to `AIModule.onSessionStart()`
- Start button is correctly disabled when microphone permission has not been granted
- `AudioSourcePicker` unit tests pass
- Build passes on macOS and Windows CI runners
