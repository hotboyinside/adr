# Issue 12 — Performance Profiling & Reliability Hardening

**Type:** AFK
**Blocked by:** Issues 07 (real-time streaming), 09 (WebSocket output)
**Priority:** Pre-release quality gate

---

## Description

Harden the end-to-end pipeline for sustained, production-quality operation. This slice covers CPU and memory profiling, GPU acceleration for Whisper, error recovery from transient failures, and buffer tuning for the latency-accuracy trade-off.

This is not a feature slice — it is a quality gate. No new user-visible features are added.

---

## 1. CPU & Memory Profiling Targets

Measure on a representative mid-range machine (e.g. Apple M2 MacBook Air, Intel Core i7-1185G7 on Windows) with `base.en` model and continuous speech input.

| Metric | Target | Measurement tool |
|---|---|---|
| CPU usage (sidecar, steady state) | < 25% single core | Instruments (macOS), Task Manager / ETW (Windows) |
| Memory (sidecar, steady state) | < 300 MB RSS | `ps`, Task Manager |
| Memory (sidecar, 30 min session) | No growth > 10 MB | Instruments Leaks, Dr. Memory |
| First `partial` event latency | < 2000 ms from speech onset | Custom timer in end-to-end test |
| Utterance queue depth (avg) | ≤ 1 pending utterance | Logged metric from sidecar |

If any target is missed, profile first, then optimise. Do not optimise blindly.

---

## 2. GPU Acceleration

### macOS — Metal (Core ML)
`whisper.cpp` supports Core ML inference on Apple Silicon and Intel Macs with Metal. Enable it via the `WHISPER_COREML` CMake flag.

```cmake
# sidecar/CMakeLists.txt
if(APPLE)
    option(WHISPER_COREML "Enable Core ML backend" ON)
    target_compile_definitions(sidecar PRIVATE WHISPER_COREML=1)
endif()
```

Core ML requires a `.mlmodelc` bundle alongside the `.bin` model. Update `scripts/download-model.sh` to also download the Core ML model package.

Expected speedup: 2–4× on Apple Silicon, ~1.5× on Intel Mac.

### Windows — CUDA (optional, not bundled)
CUDA inference requires an NVIDIA GPU and the CUDA toolkit installed on the user's machine. Do not bundle CUDA libraries.

Detection strategy:
```cpp
// At startup, attempt to initialise whisper with CUDA backend
// If CUDA is unavailable (no GPU, no toolkit), fall back to CPU silently
whisper_context_params params = whisper_context_default_params();
params.use_gpu = true; // whisper.cpp will fall back to CPU if no GPU found
ctx_ = whisper_init_from_file_with_params(modelPath.c_str(), params);
```

Log which backend is active at startup: `[sidecar] ASR backend: Metal | CUDA | CPU`

---

## 3. Error Recovery

### Sidecar Crash Recovery
The Electron main process monitors the sidecar child process. If it exits unexpectedly:

```typescript
// src/sidecar/SidecarManager.ts
sidecar.on('exit', (code) => {
  if (code !== 0 && this.sessionActive) {
    logger.error(`Sidecar exited with code ${code} — restarting`);
    setTimeout(() => this.start(), 1000); // 1-second backoff
  }
});
```

Max restart attempts: 3. After 3 failures, emit a user-facing error and stop trying.

### Audio Device Recovery (macOS)
ScreenCaptureKit can lose the stream if the audio device changes (e.g. headphones plugged in). Handle `SCStreamError` in the delegate:

```objc
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    // Emit 'error' event with code 'STREAM_INTERRUPTED'
    // SessionOrchestrator will attempt to restart capture after 500ms
}
```

### Audio Device Recovery (Windows)
Already specified in Issue 03b (`DEVICE_LOST` → `AUDCLNT_E_DEVICE_INVALIDATED`). This slice adds the auto-retry logic in `SessionOrchestrator`:

```typescript
// On DEVICE_LOST: wait for IMMNotificationClient.OnDefaultDeviceChanged
// then restart the sidecar capture within 2 seconds
```

### Whisper Model Load Failure
If the model file is missing or corrupt:
- Emit `error` event with code `MODEL_LOAD_FAILED`
- Show user-facing dialog with a "Re-download model" button
- Button triggers `scripts/download-model.sh` equivalent as a child process

---

## 4. Buffer Tuning

The VAD parameters from Issue 07 are the primary knobs. Expose them in the Settings UI:

| Setting | Default | Range | Effect |
|---|---|---|---|
| Silence padding | 300 ms | 100–1000 ms | Longer = fewer false cuts, higher latency |
| Min utterance duration | 500 ms | 100–2000 ms | Prevents single-word flushes |
| Max utterance duration | 15 s | 5–30 s | Caps latency for long sentences |
| Whisper model size | base.en | tiny / base / small / medium | Accuracy vs speed trade-off |

Store in `settings.json` via Electron `app.getPath('userData')`. Apply on next session start (no mid-session reconfiguration needed in v1).

---

## 5. Logging Strategy

The sidecar emits structured logs to `stderr` (never `stdout`, which is reserved for IPC). The Electron main process captures and writes them to a rotating log file at `~/.aura/logs/sidecar-YYYY-MM-DD.log`.

```cpp
// sidecar: log to stderr as JSON
fprintf(stderr, "{\"level\":\"info\",\"msg\":\"ASR backend: Metal\",\"ts\":%lld}\n", timestamp);
```

Log levels: `debug` (off by default), `info`, `warn`, `error`. Controlled by `AURA_LOG_LEVEL` environment variable.

Never log transcript content in production builds.

---

## Tasks

### Profiling
- [ ] Run 30-minute session on macOS and Windows; record CPU and memory profiles
- [ ] Document baseline metrics (before any optimisation) in `docs/performance-baseline.md`
- [ ] Identify the top 2 CPU hotspots from the profile; fix if they exceed targets

### GPU
- [ ] Enable Core ML in `CMakeLists.txt` for Apple targets
- [ ] Update `scripts/download-model.sh` to download Core ML model bundle for macOS
- [ ] Add CUDA auto-detect + fallback for Windows
- [ ] Log active backend on sidecar startup
- [ ] Measure and record speedup vs CPU-only in `docs/performance-baseline.md`

### Error Recovery
- [ ] Implement sidecar crash restart in `SidecarManager` (max 3 attempts)
- [ ] Implement `STREAM_INTERRUPTED` recovery for macOS ScreenCaptureKit
- [ ] Implement `DEVICE_LOST` auto-retry for Windows (via `IMMNotificationClient`)
- [ ] Implement model load failure dialog with re-download action

### Buffer Tuning
- [ ] Expose VAD parameters and model size in the Settings UI
- [ ] Persist settings to `settings.json`
- [ ] Apply settings on next session start

### Logging
- [ ] Implement rotating log file writer in Electron main process
- [ ] Capture sidecar `stderr` and write to log file
- [ ] Add `AURA_LOG_LEVEL` environment variable support
- [ ] Add "Open Log Folder" menu item to the tray menu

---

## Acceptance Criteria

- 30-minute session on target hardware stays within all profiling targets (CPU < 25%, memory < 300 MB, no growth)
- Metal acceleration is active on macOS (confirmed via startup log)
- CUDA acceleration is used when an NVIDIA GPU is present on Windows; CPU is used otherwise — no crash if CUDA is absent
- Sidecar crash triggers automatic restart; three consecutive crashes show a user-facing error
- Audio device disconnect during a session shows a recovery message and resumes within 3 seconds when the device returns
- Model load failure shows a user-facing dialog with a working re-download action
- VAD parameters and model size are configurable in the Settings UI and persist across app restarts
- Log files are written to `~/.aura/logs/` and rotated daily
