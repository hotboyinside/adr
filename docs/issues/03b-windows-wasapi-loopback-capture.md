# Issue 03b — Windows Audio Capture via WASAPI Loopback

**Type:** AFK
**Blocked by:** Issue 02 (AudioCapture interface must be stable)
**Parallel with:** Issue 03a
**Priority:** Critical path

---

## Description

Implement the Windows platform-specific `AudioCapture` using WASAPI (Windows Audio Session API) in loopback mode. This captures all system audio output without requiring a virtual audio device or elevated privileges.

The implementation is a C++ N-API addon (`sidecar/platform/windows/`) that conforms to the `AudioCapture` interface defined in Issue 02.

This slice covers:
- COM initialisation and `IMMDeviceEnumerator` setup
- Acquiring the default render endpoint in loopback mode
- `IAudioClient` + `IAudioCaptureClient` capture loop on a dedicated thread
- Exclusive-mode detection and graceful error surfacing
- Clean teardown and thread lifecycle management

---

## Architecture

```
IMMDeviceEnumerator → default render endpoint
  └── IAudioClient (AUDCLNT_STREAMFLAGS_LOOPBACK)
        └── IAudioCaptureClient
              └── capture thread (reads packets at buffer interval)
                    └── N-API threadsafe callback → emit AudioChunk to TypeScript
                          └── WindowsAudioCapture implements AudioCapture
```

---

## Key Implementation Details

### WASAPI Loopback Initialisation
```cpp
IMMDeviceEnumerator* enumerator = nullptr;
CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                 __uuidof(IMMDeviceEnumerator), (void**)&enumerator);

IMMDevice* device = nullptr;
// eRender + eConsole = default audio output device
enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);

IAudioClient* audioClient = nullptr;
device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&audioClient);

WAVEFORMATEX* pwfx = nullptr;
audioClient->GetMixFormat(&pwfx); // use device's native mix format

// AUDCLNT_STREAMFLAGS_LOOPBACK is the key flag
audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED,
                        AUDCLNT_STREAMFLAGS_LOOPBACK,
                        hnsBufferDuration, 0, pwfx, nullptr);
```

### Exclusive Mode Detection
```cpp
HRESULT hr = audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                      AUDCLNT_STREAMFLAGS_LOOPBACK, ...);
if (hr == AUDCLNT_E_DEVICE_IN_USE) {
    // Device is in exclusive mode — emit error with code EXCLUSIVE_MODE
    // Surface user-facing message: "Another application has exclusive control
    // of the audio device. Close it and try again."
}
```

### Capture Thread
```cpp
void CaptureThread() {
    audioClient->Start();
    while (capturing_) {
        UINT32 packetLength = 0;
        captureClient->GetNextPacketSize(&packetLength);
        while (packetLength != 0) {
            BYTE* pData;
            UINT32 numFrames;
            DWORD flags;
            captureClient->GetBuffer(&pData, &numFrames, &flags, nullptr, nullptr);
            if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT)) {
                // Convert to AudioChunk, emit via N-API threadsafe function
                EmitChunk(pData, numFrames, pwfx);
            }
            captureClient->ReleaseBuffer(numFrames);
            captureClient->GetNextPacketSize(&packetLength);
        }
        Sleep(bufferIntervalMs);
    }
    audioClient->Stop();
}
```

---

## Tasks

- [ ] Create `sidecar/platform/windows/WindowsAudioCapture.cpp` (C++ N-API addon)
- [ ] Implement COM initialisation (`CoInitializeEx`) with `COINIT_MULTITHREADED`
- [ ] Implement `IMMDeviceEnumerator` → default render endpoint acquisition
- [ ] Implement `IAudioClient` initialisation with `AUDCLNT_STREAMFLAGS_LOOPBACK`
- [ ] Implement `IAudioCaptureClient` packet read loop on a dedicated `std::thread`
- [ ] Implement exclusive-mode detection: catch `AUDCLNT_E_DEVICE_IN_USE`, emit `error` event with `code: 'EXCLUSIVE_MODE'`
- [ ] Implement device-lost detection: catch `AUDCLNT_E_DEVICE_INVALIDATED`, emit `error` event with `code: 'DEVICE_LOST'`
- [ ] Implement N-API threadsafe function to forward PCM chunks to the TypeScript event loop
- [ ] Implement clean `stop()`: signal capture thread, join, release all COM interfaces
- [ ] Update `sidecar/CMakeLists.txt` to conditionally compile Windows sources (`if(WIN32)`)
- [ ] Write a CLI smoke-test script (`scripts/test-capture-windows.ts`) that starts capture for 5 seconds and writes raw PCM to a `.pcm` file
- [ ] Verify the `.pcm` file is audible when played with `ffplay -f f32le -ar <device_rate> -ac <channels> output.pcm`
- [ ] Document the `WAVEFORMATEX` format returned by `GetMixFormat` in a comment (typically 32-bit float, 44100 or 48000 Hz, stereo)

---

## Acceptance Criteria

- `WindowsAudioCapture` compiles and loads as an N-API addon on Windows 10+
- Calling `start()` begins emitting `data` events with valid `AudioChunk` objects — no elevation required
- Raw PCM written by the smoke-test script is audibly correct (system audio is heard on playback)
- Calling `stop()` cleanly tears down all COM interfaces and the capture thread exits within 500 ms
- If the audio device is in exclusive mode, an `error` event is emitted with `code: 'EXCLUSIVE_MODE'` and a human-readable `message` — no crash
- If the audio device is disconnected during capture, an `error` event is emitted with `code: 'DEVICE_LOST'` — no crash
- Build passes on the Windows CI runner (Issue 04)
