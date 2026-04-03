// sidecar/asr/WhisperTranscriber.h
// Wraps whisper.cpp's whisper_full() for batch transcription.
// Input: s16le PCM at 16000 Hz mono (from Normalizer — Issue 05)
// See Issue 06.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct whisper_context;

struct TranscriptSegment {
    int64_t     startMs;
    int64_t     endMs;
    std::string text;
};

struct TranscriptResult {
    std::string                   fullText;
    std::vector<TranscriptSegment> segments;
    std::string                   language;
};

class WhisperTranscriber {
public:
    explicit WhisperTranscriber(const std::string& modelPath);
    ~WhisperTranscriber();

    WhisperTranscriber(const WhisperTranscriber&)            = delete;
    WhisperTranscriber& operator=(const WhisperTranscriber&) = delete;

    // Synchronous — blocks until transcription is complete.
    // pcm: s16le samples at 16000 Hz mono.
    TranscriptResult transcribe(const std::vector<int16_t>& pcm);

    bool isLoaded() const { return ctx_ != nullptr; }

private:
    whisper_context* ctx_ = nullptr;
};
