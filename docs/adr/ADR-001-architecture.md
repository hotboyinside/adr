# ADR-001: System Audio Capture + Real-Time Transcription Architecture

**Date:** 2026-04-03
**Status:** Accepted

---

## Context

We are building a standalone desktop application that captures system audio output (not microphone input) and produces real-time transcriptions. The product will evolve to include an AI layer that generates context-aware follow-up questions based on the live transcript. The architecture must support both macOS and Windows from day one.

---

## Decisions

### 1. Runtime Host: Electron Shell + Native C++ Sidecar

**Decision:** The application is an Electron desktop app. A native C++ sidecar process handles audio capture and ASR. The Electron main process manages the sidecar lifecycle, UI state, and AI orchestration.

**Rationale:**
- Electron provides cross-platform distribution (macOS + Windows) without platform rewrites.
- Isolating the native sidecar means a crash in audio capture or ASR does not kill the UI process.
- The sidecar can be restarted independently without losing session state held in the main process.
- TypeScript in the main process handles AI orchestration and state — consistent with existing team expertise.
- Tauri was evaluated but rejected: its Rust requirement adds a skill-set cost that Electron avoids.

**Consequences:**
- Electron adds ~150 MB to the distribution bundle. Accepted for a desktop product.
- The sidecar requires a native build step (CMake) in addition to the Node.js build.

---

### 2. macOS Audio Capture: ScreenCaptureKit

**Decision:** Use `ScreenCaptureKit` (available macOS 13+) for system audio capture. BlackHole and other virtual audio devices are explicitly excluded.

**Rationale:**
- ScreenCaptureKit is a first-party Apple framework requiring no third-party driver installation.
- Eliminates user friction of a separate BlackHole installer step.
- Compatible with Mac App Store distribution.
- macOS 13 (Ventura, 2022) is a reasonable minimum for a new product in 2026.
- Per-application audio filtering is available via `SCContentFilter`, enabling future features.

**Consequences:**
- macOS 12 and below are unsupported. If this constraint changes, a BlackHole fallback can be added behind the same `AudioCapture` interface without modifying any other layer.
- Requires `Screen Recording` permission granted by the user on first launch.

---

### 3. Windows Audio Capture: WASAPI Loopback

**Decision:** Use WASAPI in loopback mode for system audio capture on Windows.

**Rationale:**
- WASAPI loopback is the Windows-native approach requiring no virtual device installation.
- Available to any user-mode process — no elevation or UAC required.
- Supported on Windows 10 and above.

**Consequences:**
- Audio devices locked in exclusive mode cannot be captured via loopback. The application will detect this condition and surface a clear error message to the user. It will not attempt workarounds in v1.

---

### 4. ASR Engine: Whisper.cpp

**Decision:** Use `whisper.cpp` (C++ port of OpenAI Whisper) compiled as a native module loaded by the sidecar.

**Rationale:**
- Best-in-class transcription accuracy across accents and audio quality levels.
- No Python runtime dependency — ships as a compiled binary.
- Supports GPU acceleration (Metal on macOS, CUDA on Windows) with CPU fallback.
- Default model: `base.en`. User-selectable upgrade to `small.en` or `medium.en`.
- Vosk was evaluated: lower accuracy, no GPU path. DeepSpeech: unmaintained since 2021.

**Consequences:**
- `base.en` model file is ~150 MB. Bundled with the installer.
- On CPU-only hardware, `base.en` runs at approximately 2–4× real-time. Acceptable for the current use case with VAD-based chunking.

---

### 5. Voice Activity Detection: Silero VAD

**Decision:** Use Silero VAD (ONNX runtime, C++ inference) to segment audio into utterances before passing chunks to Whisper.

**Rationale:**
- Prevents feeding silence to Whisper, which reduces both latency and wasted computation.
- Silero VAD is lightweight (~1 MB model) and runs in real-time on CPU.
- Enables the real-time streaming loop: VAD detects end-of-utterance → flush chunk to Whisper → emit transcript event.

---

### 6. IPC Between Sidecar and Electron Main Process

**Decision:** Named pipe (Windows) / Unix domain socket (macOS) using a newline-delimited JSON (JSONL) protocol.

**Rationale:**
- Lower latency than WebSocket for same-machine IPC.
- No network stack required.
- Simple to implement and debug (plain text protocol).

**Message schema:**
```json
{ "type": "partial" | "final", "text": "...", "startMs": 0, "endMs": 1200 }
{ "type": "error", "code": "EXCLUSIVE_MODE" | "PERMISSION_DENIED" | "DEVICE_LOST", "message": "..." }
{ "type": "status", "value": "capturing" | "idle" | "paused" }
```

---

### 7. AI Module: Deferred, Interface Defined Now

**Decision:** The AI question-generation module is not implemented in the initial build. Its TypeScript interface and event contract are defined now so all other layers are designed against it.

**Interface:**
```typescript
interface AIModule {
  onSessionStart(context: SessionContext): void;
  onTranscript(event: TranscriptEvent): void;
  onSessionEnd(): void;
}

interface SessionContext {
  role: 'interviewer' | 'customer' | 'presenter' | 'default';
  domain?: string;
}

interface TranscriptEvent {
  type: 'partial' | 'final';
  text: string;
  startMs: number;
  endMs: number;
}
```

A no-op stub is registered at startup. The real implementation (local LLM via Ollama or cloud API) slots in without changing any other layer.

---

### 8. Cross-Platform Strategy

**Decision:** macOS and Windows are developed in parallel from Slice 2 onward. Linux (PulseAudio/PipeWire) is deferred to a later slice and is not on the critical path.

**CI matrix:** Both platforms are validated from the first native capture PR. No merging a platform slice without a passing CI build on that platform.

---

## Consequences Summary

| Layer | Technology | Notes |
|---|---|---|
| Desktop shell | Electron | Main process owns state + AI orchestration |
| macOS audio | ScreenCaptureKit | macOS 13+ required |
| Windows audio | WASAPI loopback | No elevation needed |
| Linux audio | PulseAudio / PipeWire | Deferred |
| ASR | whisper.cpp | base.en default |
| VAD | Silero VAD (ONNX) | Utterance segmentation |
| Sidecar IPC | JSONL over named pipe / Unix socket | |
| AI module | Stubbed interface | Implemented in dedicated slice |
| Language | C++ (sidecar), TypeScript (shell + AI) | |
