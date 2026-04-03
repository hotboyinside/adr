// sidecar/audio/Normalizer.h
// Converts any incoming AudioChunk PCM into Whisper's required format:
//   s16le, 16000 Hz, mono
// See Issue 05.
#pragma once

#include <cstdint>
#include <vector>

// Forward-declare to avoid pulling speexdsp headers into every translation unit
struct SpeexResamplerState_;
typedef struct SpeexResamplerState_ SpeexResamplerState;

class Normalizer {
public:
    // inputBitDepth: 16 (s16le) or 32 (f32le)
    Normalizer(int inputSampleRate, int inputChannels, int inputBitDepth);
    ~Normalizer();

    // Non-copyable — owns the resampler state
    Normalizer(const Normalizer&)            = delete;
    Normalizer& operator=(const Normalizer&) = delete;

    // Returns normalized s16le mono 16 kHz PCM.
    // inputPCM must be tightly packed in the format described by the constructor args.
    std::vector<int16_t> process(const uint8_t* inputPCM, size_t byteCount);

    // Reconfigure if the stream format changes mid-session (e.g. device switch).
    // Destroys and recreates the resampler.
    void reconfigure(int inputSampleRate, int inputChannels, int inputBitDepth);

    static constexpr int kOutputSampleRate = 16000;

private:
    std::vector<float>   downmixToMono(const float* samples, size_t frameCount) const;
    std::vector<float>   resample(const std::vector<float>& mono);
    std::vector<int16_t> convertToS16(const std::vector<float>& f32) const;

    void initResampler();
    void destroyResampler();

    SpeexResamplerState* resampler_      = nullptr;
    int                  inputSampleRate_;
    int                  inputChannels_;
    int                  inputBitDepth_;
};
