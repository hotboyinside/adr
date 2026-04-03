// sidecar/audio/NormalizerAddon.cpp
// Thin N-API wrapper around Normalizer — used by the TypeScript integration test (Issue 05).
// Not part of the production capture path; built as a separate .node addon.

#include <napi.h>
#include "Normalizer.h"

// normalize(pcm: Buffer, sampleRate: number, channels: number, bitDepth: number): Buffer
// Returns a Buffer containing s16le mono 16 kHz PCM.
static Napi::Value Normalize(const Napi::CallbackInfo& info) {
    auto env = info.Env();

    if (info.Length() < 4
     || !info[0].IsBuffer()
     || !info[1].IsNumber()
     || !info[2].IsNumber()
     || !info[3].IsNumber()) {
        Napi::TypeError::New(env,
            "normalize(pcm: Buffer, sampleRate: number, channels: number, bitDepth: number)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    auto    buf        = info[0].As<Napi::Buffer<uint8_t>>();
    int     sampleRate = info[1].As<Napi::Number>().Int32Value();
    int     channels   = info[2].As<Napi::Number>().Int32Value();
    int     bitDepth   = info[3].As<Napi::Number>().Int32Value();

    Normalizer norm(sampleRate, channels, bitDepth);
    auto out = norm.process(buf.Data(), buf.ByteLength());

    return Napi::Buffer<int16_t>::Copy(env, out.data(), out.size());
}

Napi::Object ModuleInit(Napi::Env env, Napi::Object exports) {
    exports.Set("normalize", Napi::Function::New(env, Normalize));
    return exports;
}

NODE_API_MODULE(NormalizerAddon, ModuleInit)
