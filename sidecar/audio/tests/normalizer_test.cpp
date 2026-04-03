// sidecar/audio/tests/normalizer_test.cpp
// Standalone unit test — compiled separately via CMake (test_normalizer target).
// Run with: ctest --test-dir sidecar/build -R normalizer
// See Issue 05 acceptance criteria.

#include "../Normalizer.h"

#include <cassert>
#include <cmath>
#include <cstdio>
#include <vector>

// ── Helpers ────────────────────────────────────────────────────────────────

static std::vector<uint8_t> makeStereoF32Sine(int sampleRate, float freqHz, float durationSec) {
    int frames = static_cast<int>(sampleRate * durationSec);
    std::vector<float> pcm;
    pcm.reserve(frames * 2);
    for (int i = 0; i < frames; ++i) {
        float sample = std::sin(2.0f * 3.14159265f * freqHz * i / sampleRate);
        pcm.push_back(sample);  // L
        pcm.push_back(sample);  // R
    }
    std::vector<uint8_t> bytes(pcm.size() * sizeof(float));
    std::memcpy(bytes.data(), pcm.data(), bytes.size());
    return bytes;
}

// ── Tests ──────────────────────────────────────────────────────────────────

static void test_outputIs16kHzMonoS16() {
    // Input: 48000 Hz stereo f32le, 1 second of 440 Hz sine
    const int kInputRate = 48000;
    auto pcm = makeStereoF32Sine(kInputRate, 440.0f, 1.0f);

    Normalizer norm(kInputRate, 2, 32);
    auto out = norm.process(pcm.data(), pcm.size());

    // Expected output samples: 16000 * 1 second
    // Allow ±16 samples for resampler rounding/latency
    int expected = Normalizer::kOutputSampleRate;  // 1 second
    int actual   = static_cast<int>(out.size());
    int diff     = std::abs(actual - expected);

    printf("test_outputIs16kHzMonoS16: expected ~%d samples, got %d (diff=%d)\n",
           expected, actual, diff);
    assert(diff <= 16 && "Output sample count outside ±16 tolerance");
    printf("  PASS\n");
}

static void test_downmixAveragesLR() {
    // L=1.0, R=-1.0 → mono should be ~0.0
    const int kInputRate = 16000;  // same rate so no resampling
    int frames = 256;
    std::vector<float> f32(frames * 2);
    for (int i = 0; i < frames; ++i) {
        f32[i * 2 + 0] =  1.0f;  // L
        f32[i * 2 + 1] = -1.0f;  // R
    }
    std::vector<uint8_t> bytes(f32.size() * sizeof(float));
    std::memcpy(bytes.data(), f32.data(), bytes.size());

    Normalizer norm(kInputRate, 2, 32);
    auto out = norm.process(bytes.data(), bytes.size());

    // All samples should be ~0
    for (auto s : out) {
        assert(std::abs(s) <= 1 && "Downmix L+R cancel should yield ~0");
    }
    printf("test_downmixAveragesLR: PASS\n");
}

static void test_passThroughWhenAlready16kMonoS16() {
    // Input already s16le, 16000 Hz, mono — should pass through with no resampling
    const int kInputRate = 16000;
    int frames = 512;
    std::vector<int16_t> s16(frames);
    for (int i = 0; i < frames; ++i) s16[i] = static_cast<int16_t>(i % 32767);

    std::vector<uint8_t> bytes(s16.size() * sizeof(int16_t));
    std::memcpy(bytes.data(), s16.data(), bytes.size());

    Normalizer norm(kInputRate, 1, 16);
    auto out = norm.process(bytes.data(), bytes.size());

    assert(out.size() == static_cast<size_t>(frames) && "Pass-through must preserve frame count");
    printf("test_passThroughWhenAlready16kMonoS16: PASS (frames=%zu)\n", out.size());
}

static void test_clampingPreventsSaturation() {
    // Feed values slightly above 1.0 (possible with some DSP chains)
    const int kInputRate = 16000;
    int frames = 64;
    std::vector<float> f32(frames, 1.5f);  // over-range
    std::vector<uint8_t> bytes(f32.size() * sizeof(float));
    std::memcpy(bytes.data(), f32.data(), bytes.size());

    Normalizer norm(kInputRate, 1, 32);
    auto out = norm.process(bytes.data(), bytes.size());

    for (auto s : out) {
        assert(s <= 32767 && s >= -32768 && "Clamping must keep values in s16 range");
    }
    printf("test_clampingPreventsSaturation: PASS\n");
}

static void test_reconfigureChangesRate() {
    // Start at 48k, then reconfigure to 44100
    auto pcm48 = makeStereoF32Sine(48000, 440.0f, 0.5f);
    auto pcm44 = makeStereoF32Sine(44100, 440.0f, 0.5f);

    Normalizer norm(48000, 2, 32);
    auto out48 = norm.process(pcm48.data(), pcm48.size());

    norm.reconfigure(44100, 2, 32);
    auto out44 = norm.process(pcm44.data(), pcm44.size());

    // Both 0.5 s inputs should produce ~8000 output samples
    assert(std::abs(static_cast<int>(out48.size()) - 8000) <= 16);
    assert(std::abs(static_cast<int>(out44.size()) - 8000) <= 16);
    printf("test_reconfigureChangesRate: PASS (48k→%zu, 44.1k→%zu samples)\n",
           out48.size(), out44.size());
}

// ── main ───────────────────────────────────────────────────────────────────

int main() {
    printf("=== Normalizer unit tests ===\n");
    test_outputIs16kHzMonoS16();
    test_downmixAveragesLR();
    test_passThroughWhenAlready16kMonoS16();
    test_clampingPreventsSaturation();
    test_reconfigureChangesRate();
    printf("All tests passed.\n");
    return 0;
}
