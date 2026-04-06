// sidecar/vad/VADAddon.cpp
// N-API addon wrapping SileroVAD for use from TypeScript (NativeSidecarManager).
// Exports a `SileroVAD` JavaScript class:
//   constructor(modelPath: string)
//   process(frame: Buffer): number   // Buffer must be kFrameSize * 2 bytes (Int16)
//   reset(): void
// See Issue 07.

#include <napi.h>
#include "SileroVAD.h"

class VADWrapper : public Napi::ObjectWrap<VADWrapper> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports) {
        Napi::Function func = DefineClass(env, "SileroVAD", {
            InstanceMethod<&VADWrapper::Process>("process"),
            InstanceMethod<&VADWrapper::Reset>("reset"),
        });
        exports.Set("SileroVAD", func);
        return exports;
    }

    VADWrapper(const Napi::CallbackInfo& info)
        : Napi::ObjectWrap<VADWrapper>(info)
    {
        Napi::Env env = info.Env();
        if (info.Length() < 1 || !info[0].IsString()) {
            Napi::TypeError::New(env, "SileroVAD: modelPath (string) required")
                .ThrowAsJavaScriptException();
            return;
        }
        std::string modelPath = info[0].As<Napi::String>();
        try {
            vad_ = std::make_unique<SileroVAD>(modelPath);
        } catch (const std::exception& e) {
            Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        }
    }

private:
    std::unique_ptr<SileroVAD> vad_;

    // process(frame: Buffer): number
    // frame must contain exactly SileroVAD::kFrameSize int16 samples (1024 bytes).
    Napi::Value Process(const Napi::CallbackInfo& info) {
        Napi::Env env = info.Env();
        if (!vad_) {
            Napi::Error::New(env, "SileroVAD not initialised").ThrowAsJavaScriptException();
            return env.Undefined();
        }
        if (info.Length() < 1 || !info[0].IsBuffer()) {
            Napi::TypeError::New(env, "process(frame: Buffer) expected")
                .ThrowAsJavaScriptException();
            return env.Undefined();
        }
        auto buf = info[0].As<Napi::Buffer<int16_t>>();
        if (buf.ByteLength() < SileroVAD::kFrameSize * sizeof(int16_t)) {
            Napi::RangeError::New(env,
                "frame buffer must be at least " +
                std::to_string(SileroVAD::kFrameSize * sizeof(int16_t)) + " bytes")
                .ThrowAsJavaScriptException();
            return env.Undefined();
        }
        try {
            float prob = vad_->process(buf.Data(), SileroVAD::kFrameSize);
            return Napi::Number::New(env, prob);
        } catch (const std::exception& e) {
            Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
            return env.Undefined();
        }
    }

    // reset(): void
    Napi::Value Reset(const Napi::CallbackInfo& info) {
        if (vad_) vad_->reset();
        return info.Env().Undefined();
    }
};

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
    return VADWrapper::Init(env, exports);
}

NODE_API_MODULE(VADAddon, InitModule)
