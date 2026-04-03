# Issue 07 — Voice Activity Detection + Real-Time Streaming

**Type:** AFK
**Blocked by:** Issue 06 (Whisper batch transcription working end-to-end)
**Priority:** Critical path

---

## Description

Replace the batch transcription loop with a real-time streaming pipeline. Instead of waiting for a fixed buffer to fill, Voice Activity Detection (VAD) segments the audio stream into utterances. Each utterance is flushed to Whisper independently as soon as silence is detected, producing a rolling transcript with sub-2-second latency.

This is the slice that makes the product feel real-time rather than periodic.

---

## Pipeline After This Slice

```
AudioChunk (continuous stream from capture)
  │
  ▼
Normalizer (s16le, 16kHz, mono)
  │
  ▼
SileroVAD.process(frame) → speech | silence
  │
  ├── speech  → append to utterance buffer
  │
  └── silence → if utteranceBuffer.duration >= minUtteranceMs:
                    flush utteranceBuffer to WhisperTranscriber
                      → emit 'partial' event (interim result)
                    on completion:
                      → emit 'final' event
                    reset utteranceBuffer
```

---

## VAD: Silero VAD

Silero VAD is an ONNX-format model (~1 MB) that classifies 30 ms audio frames as speech or silence. It runs in real-time on CPU with the ONNX Runtime C++ library.

### Integration
```cpp
// sidecar/vad/SileroVAD.cpp

class SileroVAD {
public:
    explicit SileroVAD(const std::string& modelPath);

    // Input: exactly 512 samples at 16kHz (= 32 ms frame)
    // Returns: speech probability [0.0, 1.0]
    float process(const int16_t* frame, size_t frameSize);

    // Stateful threshold logic
    bool isSpeech(float probability) const;
    void reset();

private:
    Ort::Session session_;
    float threshold_ = 0.5f;
    // Silero VAD requires h and c state tensors between calls
    std::array<float, 128> h_, c_;
};
```

### VAD Parameters (tunable)
```cpp
constexpr float kSpeechThreshold   = 0.5f;   // probability above = speech
constexpr int   kSilencePaddingMs  = 300;     // silence after speech before flush
constexpr int   kMinUtteranceMs    = 500;     // discard utterances shorter than this
constexpr int   kMaxUtteranceMs    = 15000;   // force-flush at 15 seconds
```

---

## Streaming Transcript Events

Partial results (while utterance is accumulating):
```json
{ "type": "partial", "text": "The meeting will", "startMs": 1200, "endMs": 0 }
```

Final result (after utterance is complete):
```json
{ "type": "final", "text": "The meeting will start at 3pm.", "startMs": 1200, "endMs": 4800 }
```

Partial events are emitted by running Whisper on the utterance buffer in a background thread at a fixed interval (every 500 ms of new speech), so the UI shows something before the utterance ends. The final event replaces the partial.

---

## Concurrency Model

```
Main capture thread         VAD thread              Whisper thread (pool, 1 worker)
──────────────────          ──────────              ──────────────────────────────
AudioChunk arrives    →     VAD.process()     →     queue.push(utteranceBuffer)
                            detects silence         WhisperTranscriber.transcribe()
                                                    emit JSONL event
```

The Whisper thread pool has exactly one worker to prevent concurrent model access (whisper.cpp is not thread-safe across calls to the same `whisper_context`). Utterance buffers are queued — if Whisper is busy when a new utterance arrives, it processes them in order.

---

## Tasks

- [ ] Add ONNX Runtime as a submodule or fetch prebuilt binaries for macOS and Windows: `sidecar/vendor/onnxruntime/`
- [ ] Add Silero VAD ONNX model to `models/silero_vad.onnx` (~1 MB, committed to git — small enough)
- [ ] Update `scripts/download-model.sh` to also download/place the VAD model
- [ ] Implement `sidecar/vad/SileroVAD.cpp` and `.h`
  - [ ] ONNX session initialisation
  - [ ] 512-sample frame processing with `h`/`c` state management
  - [ ] Threshold + silence padding logic
- [ ] Implement `sidecar/pipeline/StreamingPipeline.cpp`: orchestrates capture → VAD → utterance buffer → Whisper queue
- [ ] Implement Whisper worker thread with a `std::queue<UtteranceBuffer>` and `std::mutex`
- [ ] Implement partial transcript emission: run Whisper on current buffer every 500 ms of new speech
- [ ] Replace the batch loop from Issue 06 with `StreamingPipeline`
- [ ] Add VAD parameters to a config struct (threshold, padding, min/max utterance duration) so they can be tuned at startup without recompiling
- [ ] Write an end-to-end latency test: feed a 5-second audio clip, measure time from first speech frame to first `partial` event (target: < 2000 ms)
- [ ] Update the renderer to replace partial transcript lines with final ones (using `startMs` as the key)

---

## Acceptance Criteria

- With live system audio playing, `partial` transcript events begin appearing within 2 seconds of speech starting
- `final` events replace `partial` events in the renderer — no duplicate lines
- Silent periods between utterances produce no spurious transcriptions
- Utterances longer than `kMaxUtteranceMs` (15 s) are force-flushed and do not stall the pipeline
- Memory usage is stable over a 30-minute continuous session (no buffer accumulation)
- End-to-end latency test passes: first `partial` event within 2 seconds of first speech frame
- VAD threshold, silence padding, and min/max utterance duration are configurable at startup
