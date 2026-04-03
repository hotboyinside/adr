// MacOSAudioCapture.mm
// System audio capture via ScreenCaptureKit — N-API addon
// Requires macOS 13.0+ and Screen Recording TCC permission.
// See ADR-001 Section 2 and Issue 03a.

#include <napi.h>

#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

#include <atomic>
#include <memory>
#include <string>
#include <vector>

#include "../../audio/Normalizer.h"

// ─────────────────────────────────────────────────────────────────────────────
// Payloads passed through TSFNs
// ─────────────────────────────────────────────────────────────────────────────

struct AudioChunkPayload {
    std::vector<int16_t> pcm;   // normalized: s16le, 16 kHz, mono
    double capturedAt;           // Unix ms
    uint32_t sampleRate;         // always Normalizer::kOutputSampleRate after Issue 05
    uint32_t channels;           // always 1
};

// Used for resolving / rejecting start() and stop() promises.
// Deferred is heap-allocated and owned by this struct — deleted inside the callback.
struct PromisePayload {
    bool ok;
    std::string errorCode;
    std::string errorMessage;
    Napi::Promise::Deferred* deferred;  // non-owning in the struct; deleted in callback
};

// Extended payload for the successful-start case (need to store stream_ on JS thread)
struct StartOkPayload {
    Napi::Promise::Deferred* deferred;
    void* addon;        // MacOSAudioCaptureAddon* — avoids header-order issues
    void* stream;       // SCStream* (ARC-managed by caller)
};

// ─────────────────────────────────────────────────────────────────────────────
// SCStreamOutput delegate — runs on a background dispatch queue
// ─────────────────────────────────────────────────────────────────────────────
API_AVAILABLE(macos(13.0))
@interface SCKAudioDelegate : NSObject <SCStreamOutput>
@property (nonatomic) Napi::ThreadSafeFunction* dataTsfn;   // raw ptr, owned by addon
@property (nonatomic) Napi::ThreadSafeFunction* errorTsfn;
@property (nonatomic) Normalizer*               normalizer;  // raw ptr, owned by addon
@end

@implementation SCKAudioDelegate

- (void)stream:(SCStream*)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
                   ofType:(SCStreamOutputType)type {

    if (type != SCStreamOutputTypeAudio) return;
    if (!self.dataTsfn) return;

    CMBlockBufferRef blockBuf = CMSampleBufferGetDataBuffer(sampleBuffer);
    if (!blockBuf) return;

    size_t totalLength = 0;
    char* rawPtr = nullptr;
    if (CMBlockBufferGetDataPointer(blockBuf, 0, nullptr, &totalLength, &rawPtr) != kCMBlockBufferNoErr
        || !rawPtr || totalLength == 0) return;

    CMFormatDescriptionRef fmtDesc = CMSampleBufferGetFormatDescription(sampleBuffer);
    const AudioStreamBasicDescription* asbd =
        CMAudioFormatDescriptionGetStreamBasicDescription(fmtDesc);

    uint32_t sampleRate = asbd ? static_cast<uint32_t>(asbd->mSampleRate) : 48000;
    uint32_t channels   = asbd ? asbd->mChannelsPerFrame : 2;
    uint32_t bitDepth   = 32;  // SCKit always delivers f32le

    // ScreenCaptureKit always sets kAudioFormatFlagIsNonInterleaved (planar layout):
    //   buffer = [ L0, L1, ..., L(N-1), R0, R1, ..., R(N-1) ]
    // Normalizer::downmixToMono expects interleaved layout:
    //   buffer = [ L0, R0, L1, R1, ..., L(N-1), R(N-1) ]
    // Convert planar → interleaved here so Normalizer stays format-agnostic.
    const bool isNonInterleaved = asbd &&
        (asbd->mFormatFlags & kAudioFormatFlagIsNonInterleaved);

    // Reconfigure normalizer only when the format actually changes
    if (self.normalizer) {
        self.normalizer->reconfigure(
            static_cast<int>(sampleRate),
            static_cast<int>(channels),
            static_cast<int>(bitDepth));
    }

    // Normalize to s16le 16 kHz mono before queuing for Whisper
    std::vector<int16_t> normalized;
    if (self.normalizer) {
        if (isNonInterleaved && channels > 1) {
            // Convert planar → interleaved in a temporary buffer
            const size_t frameCount = totalLength / (sizeof(float) * channels);
            std::vector<float> interleaved(frameCount * channels);
            const float* src = reinterpret_cast<const float*>(rawPtr);
            for (size_t f = 0; f < frameCount; ++f) {
                for (uint32_t c = 0; c < channels; ++c) {
                    interleaved[f * channels + c] = src[c * frameCount + f];
                }
            }
            normalized = self.normalizer->process(
                reinterpret_cast<const uint8_t*>(interleaved.data()),
                interleaved.size() * sizeof(float));
        } else {
            normalized = self.normalizer->process(
                reinterpret_cast<const uint8_t*>(rawPtr), totalLength);
        }
    }
    if (normalized.empty()) return;

    double capturedAt = static_cast<double>([[NSDate date] timeIntervalSince1970] * 1000.0);

    auto* payload = new AudioChunkPayload{
        std::move(normalized),
        capturedAt,
        static_cast<uint32_t>(Normalizer::kOutputSampleRate),
        1
    };

    self.dataTsfn->NonBlockingCall(payload,
        [](Napi::Env env, Napi::Function jsCallback, AudioChunkPayload* p) {
            // Expose as a Buffer of bytes (int16 LE) so JS can forward to Whisper
            auto buf = Napi::Buffer<int16_t>::Copy(env, p->pcm.data(), p->pcm.size());
            auto obj = Napi::Object::New(env);
            obj.Set("pcm",        buf);
            obj.Set("capturedAt", Napi::Number::New(env, p->capturedAt));
            obj.Set("sampleRate", Napi::Number::New(env, p->sampleRate));
            obj.Set("channels",   Napi::Number::New(env, p->channels));
            obj.Set("bitDepth",   Napi::Number::New(env, 16));
            jsCallback.Call({obj});
            delete p;
        });
}

@end

// ─────────────────────────────────────────────────────────────────────────────
// N-API ObjectWrap
// ─────────────────────────────────────────────────────────────────────────────
class MacOSAudioCaptureAddon : public Napi::ObjectWrap<MacOSAudioCaptureAddon> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports) {
        Napi::Function ctor = DefineClass(env, "MacOSAudioCapture", {
            InstanceMethod("start", &MacOSAudioCaptureAddon::Start),
            InstanceMethod("stop",  &MacOSAudioCaptureAddon::Stop),
        });
        exports.Set("MacOSAudioCapture", ctor);
        return exports;
    }

    // new MacOSAudioCapture(onData, onError, onStopped)
    MacOSAudioCaptureAddon(const Napi::CallbackInfo& info)
        : Napi::ObjectWrap<MacOSAudioCaptureAddon>(info)
        , capturing_(false)
        , normalizer_(std::make_unique<Normalizer>(48000, 2, 32))
    {

        auto env = info.Env();
        if (info.Length() < 3
            || !info[0].IsFunction()
            || !info[1].IsFunction()
            || !info[2].IsFunction()) {
            Napi::TypeError::New(env,
                "Expected: new MacOSAudioCapture(onData, onError, onStopped)")
                .ThrowAsJavaScriptException();
            return;
        }

        dataTsfn_    = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "macos:data",    0, 1);
        errorTsfn_   = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "macos:error",   0, 1);
        stoppedTsfn_ = Napi::ThreadSafeFunction::New(env, info[2].As<Napi::Function>(), "macos:stopped", 0, 1);
    }

    ~MacOSAudioCaptureAddon() {
        // Detach delegate raw pointers before destroying TSFNs
        if (@available(macOS 13.0, *)) {
            if (delegate_) { delegate_.dataTsfn = nullptr; delegate_.errorTsfn = nullptr; }
        }
        dataTsfn_.Release();
        errorTsfn_.Release();
        stoppedTsfn_.Release();
    }

    // Needed by StartOkPayload callback to assign stream_ on the JS thread
    void AssignStream(SCStream* stream) API_AVAILABLE(macos(13.0)) {
        stream_ = stream;
    }

private:
    // ── start(sampleRate, channels, bitDepth) → Promise<void> ──────────────
    Napi::Value Start(const Napi::CallbackInfo& info) {
        auto env = info.Env();

        auto  deferred = Napi::Promise::Deferred::New(env);
        auto  promise  = deferred.Promise();
        auto* def      = new Napi::Promise::Deferred(std::move(deferred));

        if (capturing_.load()) {
            def->Reject(Napi::Error::New(env, "Already capturing").Value());
            delete def;
            return promise;
        }

        if (@available(macOS 13.0, *)) { /* supported */ } else {
            def->Reject(Napi::Error::New(env, "macOS 13.0+ required for ScreenCaptureKit").Value());
            delete def;
            return promise;
        }

        // Trigger TCC prompt if not yet granted
        if (!CGPreflightScreenCaptureAccess()) {
            CGRequestScreenCaptureAccess();
        }

        // One-shot TSFN for resolving/rejecting the start promise.
        // Captured by value into the ObjC block — shared_ptr copy-constructs (refcount +1).
        auto startTsfn = std::make_shared<Napi::ThreadSafeFunction>(
            Napi::ThreadSafeFunction::New(
                env,
                Napi::Function::New(env, [](const Napi::CallbackInfo&) {}),
                "macos:startResult", 0, 1));

        // Build delegate pointing at our long-lived TSFNs and the normalizer
        if (@available(macOS 13.0, *)) {
            SCKAudioDelegate* delegate = [SCKAudioDelegate new];
            delegate.dataTsfn  = &dataTsfn_;
            delegate.errorTsfn = &errorTsfn_;
            delegate.normalizer = normalizer_.get();
            delegate_ = delegate;
        }

        // Capture by value — ObjC pointer copy is a strong reference (ARC)
        SCKAudioDelegate* delegate  = delegate_;
        std::atomic<bool>* capFlag  = &capturing_;
        MacOSAudioCaptureAddon* self = this;

        [SCShareableContent getShareableContentWithCompletionHandler:
            ^(SCShareableContent* content, NSError* contentErr) {

            // ── Error: no content or permission denied ────────────────────
            if (contentErr || content.displays.count == 0) {
                bool isPerm = contentErr && (contentErr.code == -3801
                    || [contentErr.domain isEqualToString:@"com.apple.screencapturekit.stream"]);
                std::string code = isPerm ? "PERMISSION_DENIED" : "CONTENT_ERROR";
                std::string msg  = contentErr
                    ? std::string(contentErr.localizedDescription.UTF8String)
                    : "No displays found";

                // Put deferred in the payload — not in the C++ lambda capture
                auto* p = new PromisePayload{false, code, msg, def};
                startTsfn->NonBlockingCall(p,
                    [](Napi::Env env, Napi::Function, PromisePayload* p) {
                        p->deferred->Reject(
                            Napi::Error::New(env, "[" + p->errorCode + "] " + p->errorMessage).Value());
                        delete p->deferred; delete p;
                    });
                startTsfn->Release();
                return;
            }

            if (@available(macOS 13.0, *)) {
                SCDisplay* display = content.displays.firstObject;

                SCContentFilter* filter = [[SCContentFilter alloc]
                    initWithDisplay:display
                    excludingApplications:@[]
                    exceptingWindows:@[]];

                SCStreamConfiguration* cfg = [[SCStreamConfiguration alloc] init];
                cfg.capturesAudio               = YES;
                cfg.excludesCurrentProcessAudio = NO;
                cfg.width                  = 2;   // minimal video
                cfg.height                 = 2;
                cfg.minimumFrameInterval   = CMTimeMake(1, 1);
                cfg.sampleRate             = 48000;
                cfg.channelCount           = 2;

                SCStream* stream = [[SCStream alloc]
                    initWithFilter:filter
                    configuration:cfg
                    delegate:nil];

                NSError* addErr = nil;
                dispatch_queue_t q = dispatch_queue_create(
                    "com.transcribe.sck.audio", DISPATCH_QUEUE_SERIAL);

                BOOL added = [stream addStreamOutput:delegate
                                                type:SCStreamOutputTypeAudio
                                  sampleHandlerQueue:q
                                               error:&addErr];

                if (!added || addErr) {
                    std::string msg = addErr
                        ? std::string(addErr.localizedDescription.UTF8String)
                        : "Failed to add audio output";
                    auto* p = new PromisePayload{false, "SETUP_ERROR", msg, def};
                    startTsfn->NonBlockingCall(p,
                        [](Napi::Env env, Napi::Function, PromisePayload* p) {
                            p->deferred->Reject(Napi::Error::New(env, p->errorMessage).Value());
                            delete p->deferred; delete p;
                        });
                    startTsfn->Release();
                    return;
                }

                [stream startCaptureWithCompletionHandler:^(NSError* startErr) {
                    if (startErr) {
                        bool isPerm = (startErr.code == -3801);
                        std::string code = isPerm ? "PERMISSION_DENIED" : "CAPTURE_FAILED";
                        std::string msg(startErr.localizedDescription.UTF8String);
                        auto* p = new PromisePayload{false, code,
                            "[" + code + "] " + msg, def};
                        startTsfn->NonBlockingCall(p,
                            [](Napi::Env env, Napi::Function, PromisePayload* p) {
                                p->deferred->Reject(Napi::Error::New(env, p->errorMessage).Value());
                                delete p->deferred; delete p;
                            });
                    } else {
                        capFlag->store(true);
                        // Assign stream_ on the JS thread via the payload
                        struct OkCtx {
                            Napi::Promise::Deferred* deferred;
                            MacOSAudioCaptureAddon*  addon;
                            SCStream* __strong       stream;
                        };
                        auto* ctx = new OkCtx{def, self, stream};
                        startTsfn->NonBlockingCall(ctx,
                            [](Napi::Env env, Napi::Function, OkCtx* ctx) {
                                if (@available(macOS 13.0, *)) {
                                    ctx->addon->AssignStream(ctx->stream);
                                }
                                ctx->deferred->Resolve(env.Undefined());
                                delete ctx->deferred; delete ctx;
                            });
                    }
                    startTsfn->Release();
                }];
            }
        }];

        return promise;
    }

    // ── stop() → Promise<void> ──────────────────────────────────────────────
    Napi::Value Stop(const Napi::CallbackInfo& info) {
        auto env = info.Env();

        auto  deferred = Napi::Promise::Deferred::New(env);
        auto  promise  = deferred.Promise();

        if (!capturing_.load()) {
            deferred.Resolve(env.Undefined());
            return promise;
        }

        auto* def = new Napi::Promise::Deferred(std::move(deferred));

        auto stopTsfn = std::make_shared<Napi::ThreadSafeFunction>(
            Napi::ThreadSafeFunction::New(
                env,
                Napi::Function::New(env, [](const Napi::CallbackInfo&) {}),
                "macos:stopResult", 0, 1));

        capturing_.store(false);

        if (@available(macOS 13.0, *)) {
            if (delegate_) {
                delegate_.dataTsfn  = nullptr;
                delegate_.errorTsfn = nullptr;
            }
        }

        Napi::ThreadSafeFunction* stoppedPtr = &stoppedTsfn_;
        SCStream* streamToStop               = stream_;
        stream_   = nil;
        delegate_ = nil;

        [streamToStop stopCaptureWithCompletionHandler:^(NSError* stopErr) {
            // Emit 'stopped' event on the JS thread
            stoppedPtr->NonBlockingCall([](Napi::Env env, Napi::Function cb) {
                cb.Call({});
            });

            if (stopErr) {
                std::string msg(stopErr.localizedDescription.UTF8String);
                auto* p = new PromisePayload{false, "STOP_ERROR", msg, def};
                stopTsfn->NonBlockingCall(p,
                    [](Napi::Env env, Napi::Function, PromisePayload* p) {
                        p->deferred->Reject(Napi::Error::New(env, p->errorMessage).Value());
                        delete p->deferred; delete p;
                    });
            } else {
                auto* p = new PromisePayload{true, "", "", def};
                stopTsfn->NonBlockingCall(p,
                    [](Napi::Env env, Napi::Function, PromisePayload* p) {
                        p->deferred->Resolve(env.Undefined());
                        delete p->deferred; delete p;
                    });
            }
            stopTsfn->Release();
        }];

        return promise;
    }

    // ── Members ─────────────────────────────────────────────────────────────
    API_AVAILABLE(macos(13.0)) SCStream*          __strong stream_   = nil;
    API_AVAILABLE(macos(13.0)) SCKAudioDelegate*  __strong delegate_ = nil;

    Napi::ThreadSafeFunction  dataTsfn_;
    Napi::ThreadSafeFunction  errorTsfn_;
    Napi::ThreadSafeFunction  stoppedTsfn_;
    std::atomic<bool>         capturing_;
    std::unique_ptr<Normalizer> normalizer_;
};

// ─────────────────────────────────────────────────────────────────────────────
// Module entry point
// ─────────────────────────────────────────────────────────────────────────────
Napi::Object ModuleInit(Napi::Env env, Napi::Object exports) {
    return MacOSAudioCaptureAddon::Init(env, exports);
}

NODE_API_MODULE(MacOSAudioCapture, ModuleInit)
