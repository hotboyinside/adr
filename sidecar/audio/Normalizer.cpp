// sidecar/audio/Normalizer.cpp
// See Normalizer.h and Issue 05 for full design rationale.

#include "Normalizer.h"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstring>
#include <stdexcept>

// Pull in the vendored speexdsp resampler
#include "../vendor/speexdsp/speex/speex_resampler.h"

// ─────────────────────────────────────────────────────────────────────────────
// Construction / destruction
// ─────────────────────────────────────────────────────────────────────────────

Normalizer::Normalizer(int inputSampleRate, int inputChannels, int inputBitDepth)
    : inputSampleRate_(inputSampleRate)
    , inputChannels_(inputChannels)
    , inputBitDepth_(inputBitDepth)
{
    initResampler();
}

Normalizer::~Normalizer() {
    destroyResampler();
}

void Normalizer::reconfigure(int inputSampleRate, int inputChannels, int inputBitDepth) {
    if (inputSampleRate_ == inputSampleRate
     && inputChannels_   == inputChannels
     && inputBitDepth_   == inputBitDepth) return;

    inputSampleRate_ = inputSampleRate;
    inputChannels_   = inputChannels;
    inputBitDepth_   = inputBitDepth;

    destroyResampler();
    initResampler();
}

void Normalizer::initResampler() {
    if (inputSampleRate_ == kOutputSampleRate) {
        resampler_ = nullptr;  // pass-through — no resampler needed
        return;
    }
    int err = 0;
    // Quality 5: good balance of CPU and accuracy for speech
    resampler_ = speex_resampler_init(
        1,                   // mono at this point (downmix happens first)
        static_cast<spx_uint32_t>(inputSampleRate_),
        static_cast<spx_uint32_t>(kOutputSampleRate),
        5,
        &err);
    if (!resampler_ || err != RESAMPLER_ERR_SUCCESS) {
        throw std::runtime_error("speex_resampler_init failed, err=" + std::to_string(err));
    }
}

void Normalizer::destroyResampler() {
    if (resampler_) {
        speex_resampler_destroy(resampler_);
        resampler_ = nullptr;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: process
// ─────────────────────────────────────────────────────────────────────────────

std::vector<int16_t> Normalizer::process(const uint8_t* inputPCM, size_t byteCount) {
    if (!inputPCM || byteCount == 0) return {};

    // Step 0 — decode to f32 interleaved
    std::vector<float> f32interleaved;

    if (inputBitDepth_ == 32) {
        // Already f32le
        size_t floatCount = byteCount / sizeof(float);
        f32interleaved.resize(floatCount);
        std::memcpy(f32interleaved.data(), inputPCM, floatCount * sizeof(float));
    } else if (inputBitDepth_ == 16) {
        // s16le → f32
        size_t sampleCount = byteCount / sizeof(int16_t);
        f32interleaved.resize(sampleCount);
        const int16_t* s16 = reinterpret_cast<const int16_t*>(inputPCM);
        for (size_t i = 0; i < sampleCount; ++i) {
            f32interleaved[i] = static_cast<float>(s16[i]) / 32768.0f;
        }
    } else {
        // Unsupported depth — return silence rather than crash
        return {};
    }

    size_t frameCount = f32interleaved.size() / static_cast<size_t>(inputChannels_);

    // Step 1 — channel downmix → mono
    std::vector<float> mono = downmixToMono(f32interleaved.data(), frameCount);

    // Step 2 — resample to 16 kHz (no-op if already 16 kHz)
    std::vector<float> resampled = resample(mono);

    // Step 3 — f32 → s16le with clamping
    return convertToS16(resampled);
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

std::vector<float> Normalizer::downmixToMono(const float* samples, size_t frameCount) const {
    std::vector<float> mono(frameCount);

    if (inputChannels_ == 1) {
        std::memcpy(mono.data(), samples, frameCount * sizeof(float));
        return mono;
    }

    // Average all channels per frame
    const int ch = inputChannels_;
    for (size_t f = 0; f < frameCount; ++f) {
        float sum = 0.0f;
        for (int c = 0; c < ch; ++c) {
            sum += samples[f * ch + c];
        }
        mono[f] = sum / static_cast<float>(ch);
    }
    return mono;
}

std::vector<float> Normalizer::resample(const std::vector<float>& mono) {
    if (!resampler_) {
        // Already at target rate — pass through
        return mono;
    }

    // Allocate output: worst-case ceiling with generous headroom so the resampler
    // never has to leave unconsumed input samples behind.
    const spx_uint32_t totalIn = static_cast<spx_uint32_t>(mono.size());
    spx_uint32_t remaining     = totalIn;
    const float* inPtr         = mono.data();

    std::vector<float> out;
    out.reserve(static_cast<size_t>(
        std::ceil(static_cast<double>(totalIn) * kOutputSampleRate / inputSampleRate_) + 32));

    // Loop until all input samples are consumed — speexdsp may not drain everything
    // in a single call if the output buffer is exactly full.
    while (remaining > 0) {
        spx_uint32_t inChunk  = remaining;
        spx_uint32_t outChunk = static_cast<spx_uint32_t>(
            std::ceil(static_cast<double>(inChunk) * kOutputSampleRate / inputSampleRate_) + 16);

        const size_t writeOffset = out.size();
        out.resize(writeOffset + outChunk);

        int err = speex_resampler_process_float(
            resampler_,
            0,              // channel index (mono)
            inPtr,
            &inChunk,
            out.data() + writeOffset,
            &outChunk);

        if (err != RESAMPLER_ERR_SUCCESS) {
            out.resize(writeOffset);
            break;
        }

        out.resize(writeOffset + outChunk);  // trim to actual output produced
        inPtr     += inChunk;                // advance past consumed input
        remaining -= inChunk;
    }

    return out;
}

std::vector<int16_t> Normalizer::convertToS16(const std::vector<float>& f32) const {
    std::vector<int16_t> out(f32.size());
    for (size_t i = 0; i < f32.size(); ++i) {
        float clamped = std::max(-1.0f, std::min(1.0f, f32[i]));
        out[i] = static_cast<int16_t>(clamped * 32767.0f);
    }
    return out;
}
