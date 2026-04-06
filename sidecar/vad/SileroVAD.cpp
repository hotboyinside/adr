// sidecar/vad/SileroVAD.cpp
// Silero VAD v4 inference via ONNX Runtime C++ API.
// See Issue 07 and SileroVAD.h.

#include "SileroVAD.h"

#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

#include "onnxruntime_cxx_api.h"

// ─────────────────────────────────────────────────────────────────────────────
// Pimpl struct
// ─────────────────────────────────────────────────────────────────────────────

struct SileroVADImpl {
    Ort::Env         env{ ORT_LOGGING_LEVEL_WARNING, "SileroVAD" };
    Ort::Session     session{ nullptr };
    Ort::MemoryInfo  memInfo{ Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault) };

    // LSTM hidden states — Silero VAD v4 shape: [2, 1, 64] = 128 floats each
    std::array<float, 128> h = {};
    std::array<float, 128> c = {};

    // Input / output name strings (owned by the model; cached as char pointers)
    // Silero VAD v4 inputs:  "input", "sr", "h", "c"
    // Silero VAD v4 outputs: "output", "hn", "cn"
    const char* inputNames[4]  = { "input", "sr", "h", "c" };
    const char* outputNames[3] = { "output", "hn", "cn" };

    // Constant: sample rate tensor value
    int64_t srValue = SileroVAD::kSampleRate;

    SileroVADImpl() = default;
};

// ─────────────────────────────────────────────────────────────────────────────
// Construction / destruction
// ─────────────────────────────────────────────────────────────────────────────

SileroVAD::SileroVAD(const std::string& modelPath)
    : impl_(std::make_unique<SileroVADImpl>())
{
    Ort::SessionOptions opts;
    opts.SetIntraOpNumThreads(1);       // VAD is tiny; single thread is fastest
    opts.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);

    try {
#if defined(_WIN32)
        // ORT on Windows takes a wide-char path
        std::wstring wpath(modelPath.begin(), modelPath.end());
        impl_->session = Ort::Session(impl_->env, wpath.c_str(), opts);
#else
        impl_->session = Ort::Session(impl_->env, modelPath.c_str(), opts);
#endif
    } catch (const Ort::Exception& e) {
        throw std::runtime_error(
            std::string("SileroVAD: failed to load model from ") + modelPath +
            " — " + e.what());
    }
}

SileroVAD::~SileroVAD() = default;

// ─────────────────────────────────────────────────────────────────────────────
// process
// ─────────────────────────────────────────────────────────────────────────────

float SileroVAD::process(const int16_t* frame, size_t frameSize) {
    if (frameSize != kFrameSize) {
        throw std::invalid_argument(
            "SileroVAD::process requires exactly " +
            std::to_string(kFrameSize) + " samples");
    }

    auto& im = *impl_;

    // 1. Convert s16le → f32 normalised to [-1, 1]
    std::vector<float> f32(kFrameSize);
    for (size_t i = 0; i < kFrameSize; ++i) {
        f32[i] = static_cast<float>(frame[i]) / 32768.0f;
    }

    // 2. Build input tensors
    // "input": float32 [1, 512]
    int64_t inputShape[2]  = { 1, static_cast<int64_t>(kFrameSize) };
    auto inputTensor = Ort::Value::CreateTensor<float>(
        im.memInfo, f32.data(), f32.size(),
        inputShape, 2);

    // "sr": int64 [1]
    int64_t srShape[1] = { 1 };
    auto srTensor = Ort::Value::CreateTensor<int64_t>(
        im.memInfo, &im.srValue, 1,
        srShape, 1);

    // "h": float32 [2, 1, 64]
    int64_t stateShape[3] = { 2, 1, 64 };
    auto hTensor = Ort::Value::CreateTensor<float>(
        im.memInfo, im.h.data(), im.h.size(),
        stateShape, 3);

    // "c": float32 [2, 1, 64]
    auto cTensor = Ort::Value::CreateTensor<float>(
        im.memInfo, im.c.data(), im.c.size(),
        stateShape, 3);

    // Session::Run requires a contiguous array of Value objects (not pointers).
    // Ort::Value is move-only, so collect into a vector.
    std::vector<Ort::Value> inputTensors;
    inputTensors.push_back(std::move(inputTensor));
    inputTensors.push_back(std::move(srTensor));
    inputTensors.push_back(std::move(hTensor));
    inputTensors.push_back(std::move(cTensor));

    // 3. Run inference
    std::vector<Ort::Value> outputs;
    try {
        outputs = im.session.Run(
            Ort::RunOptions{ nullptr },
            im.inputNames,    inputTensors.data(), inputTensors.size(),
            im.outputNames,   3);
    } catch (const Ort::Exception& e) {
        throw std::runtime_error(std::string("SileroVAD inference error: ") + e.what());
    }

    // 4. Extract probability — output[0] is float32 [1, 1]
    float prob = *outputs[0].GetTensorData<float>();

    // 5. Update LSTM state from hn and cn
    const float* hn = outputs[1].GetTensorData<float>();
    const float* cn = outputs[2].GetTensorData<float>();
    std::copy(hn, hn + 128, im.h.data());
    std::copy(cn, cn + 128, im.c.data());

    return prob;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

bool SileroVAD::isSpeech(float probability) const {
    return probability >= threshold;
}

void SileroVAD::reset() {
    impl_->h.fill(0.0f);
    impl_->c.fill(0.0f);
}
