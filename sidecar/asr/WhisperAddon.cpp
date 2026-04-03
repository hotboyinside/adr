// sidecar/asr/WhisperAddon.cpp
// N-API addon wrapping WhisperTranscriber.
// transcribe() returns a Promise<string> — inference runs in libuv's thread pool
// so the Node.js main thread is never blocked. (Issue 06 fix: SIGBUS prevention)

#include <napi.h>
#include "WhisperTranscriber.h"

#include <atomic>
#include <memory>
#include <string>

// ─────────────────────────────────────────────────────────────────────────────
// JSON serialisation (no external dependency)
// ─────────────────────────────────────────────────────────────────────────────

static std::string escapeJson(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:   out += c;      break;
        }
    }
    return out;
}

static std::string resultToJson(const TranscriptResult& r, int64_t startMs, int64_t endMs) {
    std::string json = "{";
    json += "\"type\":\"final\",";
    json += "\"text\":\"" + escapeJson(r.fullText) + "\",";
    json += "\"startMs\":" + std::to_string(startMs) + ",";
    json += "\"endMs\":"   + std::to_string(endMs)   + ",";
    json += "\"language\":\"" + escapeJson(r.language) + "\",";
    json += "\"segments\":[";
    for (size_t i = 0; i < r.segments.size(); ++i) {
        if (i > 0) json += ",";
        const auto& seg = r.segments[i];
        json += "{\"startMs\":" + std::to_string(seg.startMs)
              + ",\"endMs\":"   + std::to_string(seg.endMs)
              + ",\"text\":\""  + escapeJson(seg.text) + "\"}";
    }
    json += "]}";
    return json;
}

// ─────────────────────────────────────────────────────────────────────────────
// Async worker — runs whisper_full() in libuv thread pool
// ─────────────────────────────────────────────────────────────────────────────

class TranscribeWorker : public Napi::AsyncWorker {
public:
    TranscribeWorker(Napi::Env env,
                     Napi::Promise::Deferred deferred,
                     WhisperTranscriber* transcriber,
                     std::vector<int16_t> pcm,
                     int64_t startMs,
                     int64_t endMs,
                     std::atomic<bool>& busy)
        : Napi::AsyncWorker(env)
        , deferred_(std::move(deferred))
        , transcriber_(transcriber)
        , pcm_(std::move(pcm))
        , startMs_(startMs)
        , endMs_(endMs)
        , busy_(busy)
    {}

    // Runs in libuv thread pool — must not touch V8/Napi objects
    void Execute() override {
        result_ = transcriber_->transcribe(pcm_);
    }

    // Runs on main thread after Execute() completes
    void OnOK() override {
        busy_.store(false);
        std::string json = resultToJson(result_, startMs_, endMs_);
        deferred_.Resolve(Napi::String::New(Env(), json));
    }

    void OnError(const Napi::Error& e) override {
        busy_.store(false);
        deferred_.Reject(e.Value());
    }

private:
    Napi::Promise::Deferred  deferred_;
    WhisperTranscriber*      transcriber_;
    std::vector<int16_t>     pcm_;
    int64_t                  startMs_;
    int64_t                  endMs_;
    TranscriptResult         result_;
    std::atomic<bool>&       busy_;
};

// ─────────────────────────────────────────────────────────────────────────────
// N-API ObjectWrap
// ─────────────────────────────────────────────────────────────────────────────

class WhisperAddonClass : public Napi::ObjectWrap<WhisperAddonClass> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports) {
        Napi::Function ctor = DefineClass(env, "WhisperAddon", {
            InstanceMethod("transcribe", &WhisperAddonClass::Transcribe),
            InstanceMethod("isLoaded",   &WhisperAddonClass::IsLoaded),
        });
        exports.Set("WhisperAddon", ctor);
        return exports;
    }

    // new WhisperAddon(modelPath: string)
    WhisperAddonClass(const Napi::CallbackInfo& info)
        : Napi::ObjectWrap<WhisperAddonClass>(info)
        , busy_(false)
    {
        auto env = info.Env();
        if (info.Length() < 1 || !info[0].IsString()) {
            Napi::TypeError::New(env, "WhisperAddon(modelPath: string)")
                .ThrowAsJavaScriptException();
            return;
        }
        std::string modelPath = info[0].As<Napi::String>().Utf8Value();
        try {
            transcriber_ = std::make_unique<WhisperTranscriber>(modelPath);
        } catch (const std::exception& e) {
            Napi::Error::New(env, e.what()).ThrowAsJavaScriptException();
        }
    }

    // transcribe(pcm: Buffer, startMs: number, endMs: number): Promise<string>
    Napi::Value Transcribe(const Napi::CallbackInfo& info) {
        auto env      = info.Env();
        auto deferred = Napi::Promise::Deferred::New(env);

        if (!transcriber_ || !transcriber_->isLoaded()) {
            deferred.Reject(Napi::Error::New(env, "Whisper model not loaded").Value());
            return deferred.Promise();
        }
        if (info.Length() < 3 || !info[0].IsBuffer()
         || !info[1].IsNumber() || !info[2].IsNumber()) {
            deferred.Reject(Napi::TypeError::New(env,
                "transcribe(pcm: Buffer, startMs: number, endMs: number)").Value());
            return deferred.Promise();
        }
        if (busy_.load()) {
            deferred.Reject(Napi::Error::New(env,
                "Transcription already in progress").Value());
            return deferred.Promise();
        }

        auto    buf     = info[0].As<Napi::Buffer<int16_t>>();
        int64_t startMs = info[1].As<Napi::Number>().Int64Value();
        int64_t endMs   = info[2].As<Napi::Number>().Int64Value();

        std::vector<int16_t> pcm(buf.Data(), buf.Data() + buf.ElementLength());

        auto promise = deferred.Promise();

        busy_.store(true);
        auto* worker = new TranscribeWorker(
            env, std::move(deferred), transcriber_.get(),
            std::move(pcm), startMs, endMs, busy_);
        worker->Queue();

        return promise;
    }

    Napi::Value IsLoaded(const Napi::CallbackInfo& info) {
        return Napi::Boolean::New(info.Env(),
            transcriber_ && transcriber_->isLoaded());
    }

private:
    std::unique_ptr<WhisperTranscriber> transcriber_;
    std::atomic<bool>                   busy_;
};

// ─────────────────────────────────────────────────────────────────────────────
// Module entry point
// ─────────────────────────────────────────────────────────────────────────────

Napi::Object ModuleInit(Napi::Env env, Napi::Object exports) {
    return WhisperAddonClass::Init(env, exports);
}

NODE_API_MODULE(WhisperAddon, ModuleInit)
