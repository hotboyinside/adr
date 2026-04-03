# Issue 06 — Whisper.cpp Integration (Batch Mode)

**Type:** AFK
**Blocked by:** Issues 01 (ADR), 05 (normalization pipeline)
**Priority:** Critical path

---

## Description

Integrate `whisper.cpp` into the C++ sidecar to produce the first end-to-end working transcript. This slice uses batch mode (process a complete audio buffer, then return the result) — streaming with VAD is introduced in Issue 07.

The goal of this slice is a verified, working pipeline:

```
Normalized PCM (s16le, 16kHz, mono)
  → whisper_full() with base.en model
  → TranscriptResult { text, segments[], language }
  → JSONL event over named pipe / Unix socket
  → Electron main process receives and logs it
```

---

## Whisper.cpp Setup

### Submodule
```bash
git submodule add https://github.com/ggerganov/whisper.cpp sidecar/vendor/whisper.cpp
```

Build only the static library (`libwhisper`), not the CLI binaries. Link into the sidecar.

### CMakeLists.txt addition
```cmake
add_subdirectory(vendor/whisper.cpp)
target_link_libraries(sidecar whisper)
```

### Model Files
- Default model: `models/ggml-base.en.bin` (~150 MB)
- Downloaded at build time via a script, not committed to git
- Add `models/*.bin` and `models/*.gguf` to `.gitignore`
- `scripts/download-model.sh` wraps the whisper.cpp model download utility

---

## Transcription Component

```cpp
// sidecar/asr/WhisperTranscriber.cpp

struct TranscriptSegment {
    int64_t startMs;
    int64_t endMs;
    std::string text;
};

struct TranscriptResult {
    std::string fullText;
    std::vector<TranscriptSegment> segments;
    std::string language;
};

class WhisperTranscriber {
public:
    explicit WhisperTranscriber(const std::string& modelPath);
    ~WhisperTranscriber();

    // Synchronous — blocks until transcription is complete
    // Input: s16le PCM samples at 16000 Hz mono
    TranscriptResult transcribe(const std::vector<int16_t>& pcm);

private:
    whisper_context* ctx_;
};
```

### whisper_full() configuration
```cpp
whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
params.print_progress   = false;
params.print_realtime   = false;
params.print_timestamps = true;
params.language         = "en";
params.n_threads        = std::max(1, (int)std::thread::hardware_concurrency() / 2);
params.single_segment   = false; // allow multi-segment output

whisper_full(ctx_, params, pcm.data(), (int)pcm.size());
```

---

## IPC Emission

On completion, emit a `final` transcript event over the named pipe / Unix socket:

```json
{
  "type": "final",
  "text": "The quick brown fox jumps over the lazy dog.",
  "startMs": 0,
  "endMs": 3200,
  "segments": [
    { "startMs": 0, "endMs": 1400, "text": "The quick brown fox" },
    { "startMs": 1400, "endMs": 3200, "text": "jumps over the lazy dog." }
  ]
}
```

---

## Test Harness

For this slice, the test harness bypasses live audio capture and feeds a pre-recorded WAV file directly to the transcriber:

```typescript
// scripts/test-transcribe.ts
// Usage: npx ts-node scripts/test-transcribe.ts path/to/test.wav
// Expects: transcript printed to stdout within 10 seconds
```

Include a 10-second English speech sample in `test-fixtures/speech-en-10s.wav` (recorded from a public domain source, committed to git — small enough at ~1.6 MB).

---

## Tasks

- [ ] Add `whisper.cpp` as a git submodule at `sidecar/vendor/whisper.cpp`
- [ ] Write `scripts/download-model.sh` to download `ggml-base.en.bin` to `models/`
- [ ] Add model download step to `README` setup instructions
- [ ] Update `sidecar/CMakeLists.txt` to build and link `libwhisper`
- [ ] Implement `sidecar/asr/WhisperTranscriber.cpp` and `.h`
  - [ ] Constructor: load model file, initialise `whisper_context`
  - [ ] `transcribe()`: call `whisper_full()`, extract segments, return `TranscriptResult`
  - [ ] Destructor: `whisper_free(ctx_)`
- [ ] Wire `WhisperTranscriber` into the sidecar main loop after the normalizer
- [ ] Implement JSONL serialisation of `TranscriptResult` and write to the IPC channel
- [ ] Implement IPC receiver in `electron/main.ts`: parse JSONL lines, emit `transcript` event to renderer via IPC
- [ ] Add test fixture: `test-fixtures/speech-en-10s.wav`
- [ ] Write `scripts/test-transcribe.ts` smoke-test script
- [ ] Verify transcript accuracy against the known content of the fixture file (manual check)
- [ ] Confirm model loads successfully on both macOS and Windows CI runners

---

## Acceptance Criteria

- Running `test-transcribe.ts` with the 10-second fixture produces a transcript within 15 seconds on CI hardware
- Transcript text matches the fixture content with word error rate < 10% (spot-checked manually)
- `TranscriptResult` is serialised correctly as JSONL and received by the Electron main process
- The renderer displays the transcript text in the UI (end-to-end path is closed)
- Memory is not leaked: `whisper_free()` is called in the destructor (validated with Instruments / Dr. Memory)
- Build passes on both macOS and Windows CI runners
