// WindowsAudioCapture.cpp
// System audio capture via WASAPI loopback — N-API addon
// Windows 10+ only. Compiled conditionally (if(WIN32) in CMakeLists.txt).
// See ADR-001 Section 3 and Issue 03b.

#include <napi.h>

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>

#include <atomic>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "../../audio/Normalizer.h"

// ─────────────────────────────────────────────────────────────────────────────
// Payloads
// ─────────────────────────────────────────────────────────────────────────────
struct AudioChunkPayload {
    std::vector<int16_t> pcm;   // normalized: s16le, 16 kHz, mono
    double capturedAt;
    uint32_t sampleRate;         // always Normalizer::kOutputSampleRate
    uint32_t channels;           // always 1
};

struct PromiseResult {
    bool ok;
    std::string errorCode;
    std::string errorMessage;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
static std::string HrToString(HRESULT hr) {
    char buf[64];
    snprintf(buf, sizeof(buf), "HRESULT 0x%08lX", static_cast<unsigned long>(hr));
    return std::string(buf);
}

template <typename T>
void SafeRelease(T** ppT) {
    if (*ppT) { (*ppT)->Release(); *ppT = nullptr; }
}

// ─────────────────────────────────────────────────────────────────────────────
// N-API ObjectWrap
// ─────────────────────────────────────────────────────────────────────────────
class WindowsAudioCaptureAddon : public Napi::ObjectWrap<WindowsAudioCaptureAddon> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports) {
        Napi::Function ctor = DefineClass(env, "WindowsAudioCapture", {
            InstanceMethod("start", &WindowsAudioCaptureAddon::Start),
            InstanceMethod("stop",  &WindowsAudioCaptureAddon::Stop),
        });
        exports.Set("WindowsAudioCapture", ctor);
        return exports;
    }

    // Constructor: new WindowsAudioCapture(onData, onError, onStopped)
    WindowsAudioCaptureAddon(const Napi::CallbackInfo& info)
        : Napi::ObjectWrap<WindowsAudioCaptureAddon>(info)
        , capturing_(false)
        , normalizer_(std::make_unique<Normalizer>(48000, 2, 32))
    {

        auto env = info.Env();
        if (info.Length() < 3
            || !info[0].IsFunction()
            || !info[1].IsFunction()
            || !info[2].IsFunction()) {
            Napi::TypeError::New(env,
                "Expected: new WindowsAudioCapture(onData, onError, onStopped)")
                .ThrowAsJavaScriptException();
            return;
        }

        dataTsfn_    = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "win:data",    0, 1);
        errorTsfn_   = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "win:error",   0, 1);
        stoppedTsfn_ = Napi::ThreadSafeFunction::New(env, info[2].As<Napi::Function>(), "win:stopped", 0, 1);
    }

    ~WindowsAudioCaptureAddon() {
        StopCapture();
        dataTsfn_.Release();
        errorTsfn_.Release();
        stoppedTsfn_.Release();
    }

private:
    // ── start({ sampleRate, channels, bitDepth }) → Promise<void> ──────────
    Napi::Value Start(const Napi::CallbackInfo& info) {
        auto env = info.Env();
        auto deferred = Napi::Promise::Deferred::New(env);
        auto promise  = deferred.Promise();

        if (capturing_.load()) {
            deferred.Reject(Napi::Error::New(env, "Already capturing").Value());
            return promise;
        }

        // COM initialisation on the calling thread (Electron main = STA is OK)
        HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) {
            deferred.Reject(Napi::Error::New(env,
                "CoInitializeEx failed: " + HrToString(hr)).Value());
            return promise;
        }

        IMMDeviceEnumerator* enumerator = nullptr;
        hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
        if (FAILED(hr)) {
            deferred.Reject(Napi::Error::New(env,
                "CoCreateInstance(MMDeviceEnumerator) failed: " + HrToString(hr)).Value());
            return promise;
        }

        // Default audio output endpoint (render = loopback source)
        IMMDevice* device = nullptr;
        hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
        SafeRelease(&enumerator);
        if (FAILED(hr)) {
            deferred.Reject(Napi::Error::New(env,
                "GetDefaultAudioEndpoint failed: " + HrToString(hr)).Value());
            return promise;
        }

        hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&audioClient_);
        SafeRelease(&device);
        if (FAILED(hr)) {
            deferred.Reject(Napi::Error::New(env,
                "Device->Activate(IAudioClient) failed: " + HrToString(hr)).Value());
            return promise;
        }

        // Use device's native mix format — typically float32, 44100 or 48000 Hz, stereo
        // Document: GetMixFormat returns the format of the shared-mode stream (the mix engine format).
        WAVEFORMATEX* pwfx = nullptr;
        hr = audioClient_->GetMixFormat(&pwfx);
        if (FAILED(hr)) {
            deferred.Reject(Napi::Error::New(env,
                "GetMixFormat failed: " + HrToString(hr)).Value());
            return promise;
        }

        // Store format details for AudioChunk
        sampleRate_ = pwfx->nSamplesPerSec;
        channels_   = pwfx->nChannels;
        bitDepth_   = pwfx->wBitsPerSample;
        blockAlign_ = pwfx->nBlockAlign;

        // 100 ms buffer
        const REFERENCE_TIME hnsBufferDuration = 1000000;  // 100ms in 100-ns units

        hr = audioClient_->Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            hnsBufferDuration, 0, pwfx, nullptr);

        CoTaskMemFree(pwfx);

        if (hr == AUDCLNT_E_DEVICE_IN_USE) {
            deferred.Reject(Napi::Error::New(env,
                "[EXCLUSIVE_MODE] Another application has exclusive control of the audio device. "
                "Close it and try again.").Value());
            return promise;
        }
        if (FAILED(hr)) {
            deferred.Reject(Napi::Error::New(env,
                "[CAPTURE_FAILED] IAudioClient::Initialize failed: " + HrToString(hr)).Value());
            return promise;
        }

        hr = audioClient_->GetService(__uuidof(IAudioCaptureClient), (void**)&captureClient_);
        if (FAILED(hr)) {
            deferred.Reject(Napi::Error::New(env,
                "GetService(IAudioCaptureClient) failed: " + HrToString(hr)).Value());
            return promise;
        }

        hr = audioClient_->Start();
        if (FAILED(hr)) {
            deferred.Reject(Napi::Error::New(env,
                "IAudioClient::Start failed: " + HrToString(hr)).Value());
            return promise;
        }

        capturing_.store(true);

        // Launch the capture thread
        captureThread_ = std::thread([this]() { CaptureLoop(); });

        deferred.Resolve(env.Undefined());
        return promise;
    }

    // ── stop() → Promise<void> ──────────────────────────────────────────────
    Napi::Value Stop(const Napi::CallbackInfo& info) {
        auto env = info.Env();
        auto deferred = Napi::Promise::Deferred::New(env);

        StopCapture();

        stoppedTsfn_.NonBlockingCall([](Napi::Env env, Napi::Function cb) {
            cb.Call({});
        });

        deferred.Resolve(env.Undefined());
        return deferred.Promise();
    }

    // ── Capture loop (dedicated thread) ────────────────────────────────────
    void CaptureLoop() {
        // Buffer poll interval — half of the buffer duration
        constexpr DWORD kSleepMs = 50;

        while (capturing_.load()) {
            UINT32 packetLength = 0;
            HRESULT hr = captureClient_->GetNextPacketSize(&packetLength);

            if (hr == AUDCLNT_E_DEVICE_INVALIDATED) {
                EmitError("DEVICE_LOST", "Audio device was disconnected during capture");
                capturing_.store(false);
                break;
            }
            if (FAILED(hr)) {
                EmitError("CAPTURE_ERROR", "GetNextPacketSize failed: " + HrToString(hr));
                capturing_.store(false);
                break;
            }

            while (packetLength != 0) {
                BYTE* pData = nullptr;
                UINT32 numFrames = 0;
                DWORD flags = 0;
                UINT64 devicePosition = 0;
                UINT64 qpcPosition    = 0;

                hr = captureClient_->GetBuffer(&pData, &numFrames, &flags,
                                               &devicePosition, &qpcPosition);
                if (hr == AUDCLNT_E_DEVICE_INVALIDATED) {
                    EmitError("DEVICE_LOST", "Audio device was disconnected during capture");
                    capturing_.store(false);
                    goto exit_loop;
                }
                if (FAILED(hr)) break;

                if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && numFrames > 0 && pData) {
                    size_t byteCount = numFrames * blockAlign_;

                    // Reconfigure normalizer if device format changed
                    normalizer_->reconfigure(
                        static_cast<int>(sampleRate_),
                        static_cast<int>(channels_),
                        static_cast<int>(bitDepth_));

                    auto normalized = normalizer_->process(pData, byteCount);
                    if (normalized.empty()) {
                        captureClient_->ReleaseBuffer(numFrames);
                        captureClient_->GetNextPacketSize(&packetLength);
                        continue;
                    }

                    double capturedAt = static_cast<double>(devicePosition) / sampleRate_ * 1000.0;
                    auto* payload = new AudioChunkPayload{
                        std::move(normalized),
                        capturedAt,
                        static_cast<uint32_t>(Normalizer::kOutputSampleRate),
                        1
                    };

                    dataTsfn_.NonBlockingCall(payload,
                        [](Napi::Env env, Napi::Function cb, AudioChunkPayload* p) {
                            auto buf = Napi::Buffer<int16_t>::Copy(env, p->pcm.data(), p->pcm.size());
                            auto obj = Napi::Object::New(env);
                            obj.Set("pcm",        buf);
                            obj.Set("capturedAt", Napi::Number::New(env, p->capturedAt));
                            obj.Set("sampleRate", Napi::Number::New(env, p->sampleRate));
                            obj.Set("channels",   Napi::Number::New(env, p->channels));
                            obj.Set("bitDepth",   Napi::Number::New(env, 16));
                            cb.Call({obj});
                            delete p;
                        });
                }

                captureClient_->ReleaseBuffer(numFrames);
                captureClient_->GetNextPacketSize(&packetLength);
            }

            Sleep(kSleepMs);
        }

    exit_loop:;
    }

    void EmitError(const std::string& code, const std::string& message) {
        struct ErrPayload { std::string code; std::string message; };
        auto* p = new ErrPayload{code, message};
        errorTsfn_.NonBlockingCall(p,
            [](Napi::Env env, Napi::Function cb, ErrPayload* p) {
                auto obj = Napi::Object::New(env);
                obj.Set("code",    Napi::String::New(env, p->code));
                obj.Set("message", Napi::String::New(env, p->message));
                cb.Call({obj});
                delete p;
            });
    }

    void StopCapture() {
        if (!capturing_.load()) return;
        capturing_.store(false);
        if (captureThread_.joinable()) captureThread_.join();
        SafeRelease(&captureClient_);
        if (audioClient_) { audioClient_->Stop(); }
        SafeRelease(&audioClient_);
    }

    // ── Members ─────────────────────────────────────────────────────────────
    IAudioClient*        audioClient_    = nullptr;
    IAudioCaptureClient* captureClient_  = nullptr;
    std::thread          captureThread_;
    std::atomic<bool>    capturing_;

    uint32_t sampleRate_ = 48000;
    uint32_t channels_   = 2;
    uint32_t bitDepth_   = 32;
    uint32_t blockAlign_ = 8;

    std::unique_ptr<Normalizer> normalizer_;

    Napi::ThreadSafeFunction dataTsfn_;
    Napi::ThreadSafeFunction errorTsfn_;
    Napi::ThreadSafeFunction stoppedTsfn_;
};

// ─────────────────────────────────────────────────────────────────────────────
// Module entry point
// ─────────────────────────────────────────────────────────────────────────────
Napi::Object ModuleInit(Napi::Env env, Napi::Object exports) {
    return WindowsAudioCaptureAddon::Init(env, exports);
}

NODE_API_MODULE(WindowsAudioCapture, ModuleInit)
