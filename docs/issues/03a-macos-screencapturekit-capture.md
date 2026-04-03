# Issue 03a — macOS Audio Capture via ScreenCaptureKit

**Type:** AFK
**Blocked by:** Issue 02 (AudioCapture interface must be stable)
**Parallel with:** Issue 03b
**Priority:** Critical path

---

## Description

Implement the macOS platform-specific `AudioCapture` by wrapping Apple's `ScreenCaptureKit` framework in a C++ native module (Node.js N-API addon) that conforms to the interface defined in Issue 02.

ScreenCaptureKit was chosen over BlackHole / virtual audio devices (see ADR-001). It requires macOS 13+ and the `Screen Recording` permission.

This slice covers:
- Native N-API addon in Objective-C++ (`sidecar/platform/macos/`)
- `SCStreamConfiguration` set to audio-only capture
- `SCContentFilter` scoped to system audio (all applications)
- `SCStreamOutput` delegate forwarding raw PCM chunks to the TypeScript layer
- Permission check and request flow integrated into the addon

---

## Architecture

```
ScreenCaptureKit (macOS framework)
  └── SCStream (audio-only mode)
        └── SCStreamOutput delegate
              └── CMSampleBuffer → extract PCM
                    └── N-API addon → emit AudioChunk to TypeScript
                          └── MacOSAudioCapture implements AudioCapture
```

---

## Key Implementation Details

### SCStreamConfiguration (audio only)
```objc
SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
config.capturesAudio = YES;
config.excludesCurrentProcessAudio = NO;
// No video — minimises resource usage
config.width = 1;
config.height = 1;
config.minimumFrameInterval = CMTimeMake(1, 1); // 1 fps placeholder, audio is independent
```

### Permission Check
```objc
// Check before starting capture
SCShareableContentStyle style = SCShareableContentStyleWindow;
[SCShareableContent getShareableContentWithCompletionHandler:^(SCShareableContent *content, NSError *error) {
    if (error.code == SCStreamErrorUserDeclined) {
        // Surface PERMISSION_DENIED error to TypeScript layer
    }
}];
```

### PCM extraction from CMSampleBuffer
```objc
- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
                   ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeAudio) return;
    // Extract AudioBufferList, convert to interleaved Int16 PCM, emit via N-API callback
}
```

---

## Tasks

- [ ] Create `sidecar/platform/macos/MacOSAudioCapture.mm` (Objective-C++ N-API addon)
- [ ] Implement `SCStreamConfiguration` for audio-only capture
- [ ] Implement `SCContentFilter` targeting all system audio
- [ ] Implement `SCStreamOutput` delegate: extract `CMSampleBuffer` → raw PCM `Buffer`
- [ ] Implement permission check: call `CGPreflightScreenCaptureAccess()` on start; if denied, emit `error` event with code `PERMISSION_DENIED`
- [ ] Implement permission request: call `CGRequestScreenCaptureAccess()` and wait for user response
- [ ] Emit `AudioChunk` objects conforming to the `AudioCapture` interface on each buffer
- [ ] Update `sidecar/CMakeLists.txt` to conditionally compile macOS sources (`if(APPLE)`)
- [ ] Write a CLI smoke-test script (`scripts/test-capture-macos.ts`) that starts capture for 5 seconds and writes raw PCM to a `.pcm` file
- [ ] Verify the `.pcm` file is audible when played back with `ffplay -f s16le -ar 48000 -ac 2 output.pcm`
- [ ] Add `com.apple.security.screen-capture` entitlement to `electron-builder.config.js` for macOS builds

---

## Acceptance Criteria

- `MacOSAudioCapture` compiles and loads as an N-API addon on macOS 13+
- Calling `start()` triggers the macOS Screen Recording permission dialog on first run
- After permission is granted, `data` events are emitted continuously with valid `AudioChunk` objects
- Raw PCM written by the smoke-test script is audibly correct (system audio is heard on playback)
- Calling `stop()` cleanly tears down the `SCStream` with no resource leaks (validated with Instruments — Leaks)
- If permission is denied, an `error` event is emitted with `code: 'PERMISSION_DENIED'` — no crash
- Build passes on the macOS CI runner (Issue 04)
