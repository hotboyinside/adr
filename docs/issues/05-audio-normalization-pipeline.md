# Issue 05 — Audio Normalization Pipeline

**Type:** AFK
**Blocked by:** Issue 02 (AudioCapture interface), Issues 03a + 03b recommended (real input to test against)
**Priority:** Critical path

---

## Description

Raw PCM from ScreenCaptureKit and WASAPI arrives in the device's native format — typically 32-bit float, 44100 or 48000 Hz, stereo. Whisper.cpp requires 16-bit signed integer PCM, 16000 Hz, mono.

This slice implements a normalization pipeline inside the C++ sidecar that converts any incoming `AudioChunk` into Whisper's expected format before it reaches the ASR layer.

The normalizer runs in the sidecar process (not the Electron main process) to keep CPU-heavy resampling off the UI thread.

---

## Normalization Steps

```
Raw AudioChunk (e.g. f32le, 48000 Hz, stereo)
  │
  ▼
1. Channel downmix  → average L+R channels → mono
  │
  ▼
2. Resample         → 48000 Hz → 16000 Hz  (ratio 1:3)
  │
  ▼
3. Format convert   → f32 → s16le (multiply by 32767, clamp)
  │
  ▼
NormalizedChunk (s16le, 16000 Hz, mono)  → Whisper input buffer
```

---

## Library Choice

Use **libspeexdsp** for resampling (lightweight, BSD licensed, no Python, ships as a single `.c` file that can be compiled directly into the sidecar). Do not use FFmpeg as a library dependency — it adds significant binary size and build complexity. FFmpeg CLI may be used in smoke-test scripts only.

Alternative if libspeexdsp proves insufficient: `r8brain-free-src` (header-only C++ resampler, MIT licensed).

---

## Key Implementation

```cpp
// sidecar/audio/Normalizer.cpp

class Normalizer {
public:
    Normalizer(int inputSampleRate, int inputChannels, int inputBitDepth);

    // Returns normalized s16le mono 16kHz PCM
    std::vector<int16_t> process(const uint8_t* inputPCM, size_t byteCount);

private:
    SpeexResamplerState* resampler_;
    int inputSampleRate_;
    int inputChannels_;
    int inputBitDepth_;

    std::vector<float> downmixToMono(const float* samples, size_t frameCount);
    std::vector<float> resample(const std::vector<float>& mono);
    std::vector<int16_t> convertToS16(const std::vector<float>& f32);
};
```

---

## Format Negotiation

WASAPI's `GetMixFormat()` returns the device's native mix format at runtime — it is not always the same across machines. The normalizer must read the incoming `AudioChunk` header fields (`sampleRate`, `channels`, `bitDepth`) to configure itself dynamically, not assume a fixed input format.

```typescript
// AudioChunk carries enough info for the normalizer to self-configure
interface AudioChunk {
  pcm: Buffer;
  capturedAt: number;
  sampleRate: number;   // from device — 44100 | 48000 | other
  channels: number;     // 1 | 2
  bitDepth: number;     // 16 | 32
}
```

---

## Tasks

- [ ] Add `libspeexdsp` source to `sidecar/vendor/speexdsp/` and include in `CMakeLists.txt`
- [ ] Implement `sidecar/audio/Normalizer.cpp` and `Normalizer.h`
  - [ ] Channel downmix: average L+R for stereo input
  - [ ] Resample via `speex_resampler_process_float()` to 16000 Hz
  - [ ] Format conversion: f32 → s16le with clamping; pass-through if already s16le
- [ ] Wire `Normalizer` into the capture loop: every `AudioChunk` passes through before being queued for Whisper
- [ ] Handle dynamic reconfiguration: if `sampleRate` or `channels` changes between chunks (e.g. device switch), reinitialise the resampler
- [ ] Write a unit test (`sidecar/audio/tests/normalizer_test.cpp`) that:
  - Feeds synthetic 48000 Hz stereo f32 sine wave
  - Asserts output is 16000 Hz mono s16le
  - Asserts output sample count matches expected ratio (within ±1 sample for rounding)
- [ ] Write a TypeScript integration test that pipes a known WAV file through the native normalizer and verifies the output duration matches the input duration

---

## Acceptance Criteria

- All input from macOS (ScreenCaptureKit, typically f32, 48000 Hz, stereo) is correctly normalized to s16le, 16000 Hz, mono
- All input from Windows (WASAPI, typically f32 or s16, 44100/48000 Hz, stereo) is correctly normalized
- If input is already 16000 Hz mono s16le, it passes through with no resampling work
- C++ unit test passes with a synthetic input signal
- TypeScript integration test passes with a real WAV file
- CPU usage of the normalizer is under 5% on a modern CPU at 48000 Hz stereo input (profiled with `perf` or Instruments)
- Build passes on both CI platform runners
