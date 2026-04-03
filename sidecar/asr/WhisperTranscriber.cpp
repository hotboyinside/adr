// sidecar/asr/WhisperTranscriber.cpp
// See WhisperTranscriber.h and Issue 06.

#include "WhisperTranscriber.h"

#include <algorithm>
#include <stdexcept>
#include <thread>
#include <vector>

#include "whisper.h"

// ─────────────────────────────────────────────────────────────────────────────
// Construction / destruction
// ─────────────────────────────────────────────────────────────────────────────

WhisperTranscriber::WhisperTranscriber(const std::string& modelPath) {
    whisper_context_params cparams = whisper_context_default_params();
    cparams.use_gpu    = false;  // CPU only for now; GPU (Metal/CUDA) enabled in Issue 12
    cparams.flash_attn = false;  // disable — alignment reqs conflict with Electron's PartitionAlloc

    ctx_ = whisper_init_from_file_with_params(modelPath.c_str(), cparams);
    if (!ctx_) {
        throw std::runtime_error("Failed to load Whisper model from: " + modelPath);
    }
}

WhisperTranscriber::~WhisperTranscriber() {
    if (ctx_) {
        whisper_free(ctx_);
        ctx_ = nullptr;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// transcribe
// ─────────────────────────────────────────────────────────────────────────────

TranscriptResult WhisperTranscriber::transcribe(const std::vector<int16_t>& pcm) {
    if (!ctx_ || pcm.empty()) return {};

    // whisper_full() requires f32 samples
    std::vector<float> f32(pcm.size());
    for (size_t i = 0; i < pcm.size(); ++i) {
        f32[i] = static_cast<float>(pcm[i]) / 32768.0f;
    }

    // Beam search gives noticeably better accuracy than greedy at the cost of
    // ~3-5x more compute. Acceptable for 5-second batch windows.
    whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_BEAM_SEARCH);
    params.beam_search.beam_size = 5;
    params.print_progress    = false;
    params.print_realtime    = false;
    params.print_timestamps  = true;
    params.language          = "en";
    // The subprocess owns all CPU cores — use up to 8 threads (whisper.cpp
    // doesn't scale well beyond 8 due to transformer parallelism limits).
    params.n_threads         = std::min(8, std::max(1, static_cast<int>(
                                   std::thread::hardware_concurrency())));
    params.single_segment    = false;
    params.no_context        = true;   // don't carry context between calls in batch mode


    int rc = whisper_full(ctx_, params, f32.data(), static_cast<int>(f32.size()));
    if (rc != 0) return {};

    TranscriptResult result;
    result.language = whisper_lang_str(whisper_full_lang_id(ctx_));

    int nSegments = whisper_full_n_segments(ctx_);
    for (int i = 0; i < nSegments; ++i) {
        const char* text = whisper_full_get_segment_text(ctx_, i);
        int64_t t0 = whisper_full_get_segment_t0(ctx_, i) * 10;  // centiseconds → ms
        int64_t t1 = whisper_full_get_segment_t1(ctx_, i) * 10;

        if (text && text[0] != '\0') {
            result.segments.push_back({t0, t1, std::string(text)});
            result.fullText += text;
        }
    }

    return result;
}
