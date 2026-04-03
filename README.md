# Transcribe

A cross-platform desktop application that captures system audio output and produces real-time transcriptions. Built with Electron + a native C++ sidecar.

**Platforms:** macOS 13+ · Windows 10+
**Status:** Active development — Issue 02 (Electron shell skeleton) complete

---

## Architecture

All architectural decisions are documented in [`docs/adr/ADR-001-architecture.md`](docs/adr/ADR-001-architecture.md).

| Layer | Technology |
|---|---|
| Desktop shell | Electron (TypeScript) |
| macOS audio | ScreenCaptureKit (macOS 13+) |
| Windows audio | WASAPI loopback |
| ASR | whisper.cpp (`base.en` default) |
| VAD | Silero VAD (ONNX) |
| Sidecar IPC | JSONL over Unix socket / named pipe |
| AI module | Stubbed — implemented in dedicated slice |

---

## Development

```bash
npm install
npm run dev        # build and launch Electron app
```

### Build for distribution

```bash
npm run dist:mac   # .dmg (universal, macOS 13+)
npm run dist:win   # NSIS installer (Windows x64)
```

---

## Project Structure

```
electron/          Electron main process, preload, tray
src/
  capture/         AudioCapture interface (stable — ADR-001)
  sidecar/         SidecarManager interface + MockSidecarManager
  ai/              AIModule interface + NoOpAIModule stub
  session/         SessionState types
renderer/          React UI
sidecar/           Native C++ sidecar (implemented in Slices 03a/03b)
docs/adr/          Architecture Decision Records
docs/issues/       Issue definitions
```
