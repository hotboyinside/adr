# Issue 13 — Microphone Capture + Permissions

**Type:** AFK
**Blocked by:** Issue 07 (streaming pipeline end-to-end), Issue 10 (permissions UX patterns)
**Priority:** Critical path

---

## Description

Add the user's microphone as a second audio source. This slice implements platform-specific microphone capture for macOS and Windows, resamples the input to the 16 kHz mono s16le format Whisper expects, and wires it into the existing Normalizer → VAD → Whisper pipeline — no changes to the pipeline itself are required.

It also handles all microphone-specific permissions: macOS requires an explicit `Microphone` permission separate from Screen Recording; Windows needs input device enumeration and clear error handling for common failure modes.

The existing `AudioCapture` interface (Issue 02) is already broad enough — this slice adds a new concrete implementation, not a new interface.

---

## Architecture

```
Microphone hardware
  │
  ▼
MacOSMicCapture (AVAudioEngine)    WindowsMicCapture (WASAPI input)
  │                                        │
  └─────────────────┬──────────────────────┘
                    ▼
              AudioChunk  (native device rate — e.g. 44100 / 48000 Hz)
                    │
                    ▼
              Normalizer  (existing — converts to s16le, 16000 Hz, mono)
                    │
                    ▼
              SileroVAD → WhisperTranscriber  (existing — unchanged)
```

---

## macOS: AVAudioEngine Capture

Use `AVAudioEngine` with an input tap on `inputNode`. This is the standard API for microphone capture on macOS and does not require ScreenCaptureKit or Screen Recording permission.

### Permission Flow

```typescript
type MicPermissionState = 'granted' | 'not-determined' | 'denied';
```

```objc
// Check before starting
AVAuthorizationStatus status =
    [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];

// Request if not-determined
[AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                         completionHandler:^(BOOL granted) {
    // Surface result to TypeScript layer via N-API callback
}];
```

When denied, redirect the user to System Settings — same pattern as Issue 10's Screen Recording guidance:

```typescript
shell.openExternal(
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
);
```

### Info.plist

Add `NSMicrophoneUsageDescription` via `electron-builder.config.js`:

```javascript
mac: {
  extendInfo: {
    NSMicrophoneUsageDescription:
      'Aura uses your microphone to transcribe what you say in real time. ' +
      'Audio is processed locally and never sent to external servers.'
  }
}
```

### AVAudioEngine Setup

```objc
// sidecar/platform/macos/MacOSMicCapture.mm

AVAudioEngine *engine = [[AVAudioEngine alloc] init];
AVAudioInputNode *inputNode = engine.inputNode;

// Use hardware format — Normalizer handles sample-rate conversion
AVAudioFormat *hwFormat = [inputNode inputFormatForBus:0];

[inputNode installTapOnBus:0
               bufferSize:4096
                   format:hwFormat
                    block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
    // Convert AVAudioPCMBuffer → raw PCM bytes → emit AudioChunk
    // sampleRate = hwFormat.sampleRate  (typically 44100 or 48000)
    // channels   = hwFormat.channelCount
    // bitDepth   = 32  (AVAudioPCMBuffer is always f32)
}];

[engine startAndReturnError:&error];
```

Clean teardown: `[inputNode removeTapOnBus:0]`, then `[engine stop]`.

---

## Windows: WASAPI Input Capture

Use WASAPI in **shared mode** for microphone input. No special OS permission is required, but device enumeration and error handling are critical.

### Device Enumeration

```cpp
// sidecar/platform/windows/WindowsMicCapture.cpp

IMMDeviceEnumerator* pEnum = nullptr;
CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
                 CLSCTX_ALL, IID_PPV_ARGS(&pEnum));

IMMDeviceCollection* pCollection = nullptr;
pEnum->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &pCollection);
```

Expose the device list to the TypeScript layer over IPC so the renderer can populate a device picker (Issue 14).

### Error Handling

| Error | User-visible guidance |
|---|---|
| `AUDCLNT_E_DEVICE_IN_USE` | "Your microphone is in exclusive use by another app. Close it and try again." |
| No active capture devices | "No microphone detected. Connect a microphone and try again." |
| Device disconnected mid-session | Toast: "Microphone disconnected." — stop capture cleanly, emit `stopped` event |

---

## Consent Dialog Update

The first-launch consent dialog (Issue 10) currently mentions system audio only. Update the copy to cover both sources:

```
┌──────────────────────────────────────────────────────┐
│  Aura captures audio to transcribe in real time      │
│                                                      │
│  Depending on which source you choose, Aura needs    │
│  access to:                                          │
│  • System audio — what your speakers play            │
│  • Your microphone — what you say                    │
│                                                      │
│  • All audio is processed locally on your device     │
│  • Nothing is sent to external servers               │
│  • You can stop capture at any time                  │
│                                                      │
│  [Learn more]                       [Continue]       │
└──────────────────────────────────────────────────────┘
```

---

## New IPC Surface

```typescript
// Additions to electron/preload.ts context bridge

getMicrophoneDevices(): Promise<MicDevice[]>
// Returns list of available input devices: [{ id, name, isDefault }]

checkMicrophonePermission(): Promise<MicPermissionState>    // macOS only
requestMicrophonePermission(): Promise<MicPermissionState>  // macOS only
```

```typescript
interface MicDevice {
  id: string;
  name: string;
  isDefault: boolean;
}
```

---

## Tasks

### macOS
- [ ] Create `sidecar/platform/macos/MacOSMicCapture.mm`
  - [ ] `AVAudioEngine` input tap setup using hardware format
  - [ ] Convert `AVAudioPCMBuffer` f32 data to `AudioChunk` (emit native sample rate — Normalizer resamples)
  - [ ] Clean teardown: remove tap, stop engine
- [ ] Implement permission helpers in `src/permissions/MacOSPermissions.ts`:
  - [ ] `checkMicrophonePermission()` → `MicPermissionState`
  - [ ] `requestMicrophonePermission()` → triggers system dialog
  - [ ] `openMicrophoneSystemSettings()` → deep link to Privacy > Microphone
- [ ] Add `NSMicrophoneUsageDescription` to `electron-builder.config.js`
- [ ] Add `com.apple.security.microphone` entitlement for macOS builds
- [ ] Gate mic `start()` behind permission check in `electron/main.ts` (same pattern as Issue 10)
- [ ] Reuse `PermissionGate` renderer component from Issue 10, parameterised by permission type

### Windows
- [ ] Create `sidecar/platform/windows/WindowsMicCapture.cpp`
  - [ ] WASAPI shared-mode input client setup
  - [ ] Device enumeration via `IMMDeviceEnumerator` (eCapture)
  - [ ] Capture loop: read from `IAudioCaptureClient`, emit `AudioChunk`
  - [ ] Handle `AUDCLNT_E_DEVICE_IN_USE` and device-disconnection errors
- [ ] Expose device list over IPC: `getMicrophoneDevices` handler in `electron/main.ts`

### Both Platforms
- [ ] Add `MicrophoneCapture` source type to `src/capture/platform.ts`
- [ ] Update first-launch consent dialog copy to mention both audio sources
- [ ] Write smoke-test script `scripts/test-capture-mic.ts`:
  - Start mic capture for 5 seconds, write raw PCM to a file
  - Verify output is audible: `ffplay -f s16le -ar 16000 -ac 1 output.pcm`
- [ ] Integration test: 5 seconds of mic input through the full pipeline (Normalizer → VAD → Whisper), assert a non-empty transcript is produced

---

## Acceptance Criteria

- On macOS: mic capture starts after `Microphone` permission is granted; if denied, "How to Enable" screen appears with a working System Settings deep link
- On Windows: mic device list enumerates correctly; `AUDCLNT_E_DEVICE_IN_USE` surfaces a clear error modal; device disconnection stops capture cleanly without crashing
- `AudioChunk` objects from mic capture flow through the existing Normalizer → VAD → Whisper pipeline with no changes to those components
- Speaking into the microphone produces a rolling transcript in the renderer within 2 seconds of speech onset (same latency target as Issue 07)
- `NSMicrophoneUsageDescription` is present in the macOS build's `Info.plist`
- No mic capture begins before the user has acknowledged the updated consent dialog
- Build passes on macOS and Windows CI runners
