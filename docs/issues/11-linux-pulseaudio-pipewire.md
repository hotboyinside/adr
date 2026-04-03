# Issue 11 — Linux Audio Capture (PulseAudio / PipeWire)

**Type:** AFK
**Blocked by:** Issue 02 (AudioCapture interface)
**Priority:** Deferred — not on critical path

---

## Description

Add Linux as a supported platform by implementing a PulseAudio monitor source capture, with PipeWire as the preferred backend where available (PipeWire exposes a PulseAudio-compatible API, so the same implementation covers both).

This slice is intentionally deferred. macOS and Windows are the primary targets. Linux support is added once the core pipeline is stable on both primary platforms.

---

## Approach

PipeWire (used in modern Ubuntu, Fedora, Arch) exposes a PulseAudio-compatible API. Capturing via the PulseAudio API (`libpulse`) works on both PulseAudio and PipeWire without separate implementations.

### Monitor Source
PulseAudio's "monitor" sources capture the audio output of a sink (speakers). The monitor source name is typically `<sink-name>.monitor` (e.g., `alsa_output.pci-0000_00_1f.3.analog-stereo.monitor`).

```cpp
// sidecar/platform/linux/LinuxAudioCapture.cpp

// 1. Connect to PulseAudio server
pa_mainloop* mainloop = pa_mainloop_new();
pa_context* context = pa_context_new(pa_mainloop_get_api(mainloop), "aura");
pa_context_connect(context, nullptr, PA_CONTEXT_NOFLAGS, nullptr);

// 2. Get default sink monitor source name
pa_context_get_server_info(context, [](pa_context* c, const pa_server_info* info, void* userdata) {
    std::string monitorSource = std::string(info->default_sink_name) + ".monitor";
    // Store for use in step 3
}, &monitorSourceName);

// 3. Create record stream on the monitor source
pa_sample_spec spec = { PA_SAMPLE_S16LE, 16000, 1 }; // request 16kHz mono directly
pa_stream* stream = pa_stream_new(context, "aura-capture", &spec, nullptr);
pa_stream_connect_record(stream, monitorSourceName.c_str(), nullptr, PA_STREAM_NOFLAGS);

// 4. Read data in the mainloop
pa_stream_set_read_callback(stream, [](pa_stream* s, size_t length, void* userdata) {
    const void* data;
    pa_stream_peek(s, &data, &length);
    // Emit AudioChunk
    pa_stream_drop(s);
}, this);
```

### User Group Requirement
The user must be a member of the `audio` group (or `pulse-access` on some distros). The app should check this on startup and show a setup guide if not satisfied.

```bash
# One-time setup (user must log out and back in after)
sudo usermod -aG audio $USER
```

---

## Tasks

- [ ] Add `libpulse-dev` to the Linux build prerequisites in `README.md`
- [ ] Implement `sidecar/platform/linux/LinuxAudioCapture.cpp` and `.h`
  - [ ] PulseAudio context connection with retry on timeout
  - [ ] Default sink monitor source name discovery
  - [ ] Record stream setup requesting 16kHz mono s16le natively (avoids extra normalizer work)
  - [ ] Read callback: convert `pa_stream_peek()` data to `AudioChunk` and emit
  - [ ] Clean teardown: disconnect stream and context, free mainloop
- [ ] Add `linux` target to `sidecar/CMakeLists.txt` (`elseif(UNIX AND NOT APPLE)`)
- [ ] Detect PipeWire vs PulseAudio at runtime (for error messages only — both use the same API)
- [ ] Implement user group check in `src/permissions/LinuxPermissions.ts`:
  - [ ] Check if current user is in `audio` or `pulse-access` group
  - [ ] If not: show setup guide with the `usermod` command to run
- [ ] Add `ubuntu-latest` runner to the CI matrix in `.github/workflows/ci.yml`
- [ ] Write a CLI smoke-test script (`scripts/test-capture-linux.ts`) equivalent to the macOS and Windows versions
- [ ] Update `electron-builder.config.js` with a Linux `.AppImage` target

---

## Acceptance Criteria

- `LinuxAudioCapture` compiles and loads on Ubuntu 22.04+ (CI runner)
- With PulseAudio or PipeWire running, `data` events are emitted with valid `AudioChunk` objects
- Monitor source is auto-discovered from the default sink — no manual configuration required
- If the user is not in the `audio` group, a setup guide is shown — no crash
- Smoke-test script produces an audibly correct `.pcm` file
- CI matrix updated: Linux build passes on `ubuntu-latest`
- AppImage builds successfully via `electron-builder`
