// sidecar/vad/SileroVAD.h
// Wraps the Silero VAD ONNX model for real-time speech/silence classification.
// Input: 512-sample frames (32ms at 16kHz mono s16le, from Normalizer).
// See Issue 07.
#pragma once

#include <cstdint>
#include <memory>
#include <string>

// Pimpl — keeps ONNX Runtime headers out of every translation unit that
// includes this header.
struct SileroVADImpl;

class SileroVAD {
public:
    explicit SileroVAD(const std::string& modelPath);
    ~SileroVAD();

    SileroVAD(const SileroVAD&)            = delete;
    SileroVAD& operator=(const SileroVAD&) = delete;

    // Process exactly kFrameSize s16le samples (= 32ms at 16kHz).
    // Maintains LSTM h/c state between calls — do NOT interleave calls from
    // different utterance streams without calling reset() first.
    // Returns speech probability in [0.0, 1.0].
    float process(const int16_t* frame, size_t frameSize);

    // Convenience: true if probability >= threshold (default 0.5).
    bool isSpeech(float probability) const;

    // Reset LSTM state — call between utterances or on session stop.
    void reset();

    // ── Tunable parameters ────────────────────────────────────────────────────
    static constexpr size_t kFrameSize   = 512;    // samples per call
    static constexpr int    kSampleRate  = 16000;  // Hz

    // VAD decision thresholds — exposed for tests / future config struct.
    float threshold         = 0.5f;    // speech probability cutoff
    int   silencePaddingMs  = 300;     // silence tail to append before flush
    int   minUtteranceMs    = 500;     // discard shorter utterances
    int   maxUtteranceMs    = 15000;   // force-flush at this duration

private:
    std::unique_ptr<SileroVADImpl> impl_;
};
