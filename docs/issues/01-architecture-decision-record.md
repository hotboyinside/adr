# Issue 01 — Commit Architecture Decision Record

**Type:** AFK
**Blocked by:** None — start immediately
**Priority:** Critical path

---

## Description

Commit `ADR-001` to the repository so all subsequent implementation slices have a single authoritative reference for every architectural decision. This issue is already resolved by the design discussion; the task is to land the document and make it discoverable.

The ADR covers:
- Electron shell + native C++ sidecar topology
- ScreenCaptureKit for macOS (macOS 13+)
- WASAPI loopback for Windows
- Whisper.cpp as the ASR engine
- Silero VAD for utterance segmentation
- JSONL over named pipe / Unix socket for sidecar IPC
- AI module deferred with interface defined now
- macOS + Windows parallel from day one; Linux deferred

---

## Tasks

- [ ] Place `docs/adr/ADR-001-architecture.md` in the repository root
- [ ] Add a `# Architecture` section to `README.md` linking to the ADR
- [ ] Confirm the repository `.gitignore` excludes model files (`*.bin`, `*.gguf`) and build artifacts (`build/`, `dist/`)

---

## Acceptance Criteria

- `docs/adr/ADR-001-architecture.md` is present and readable on the main branch
- `README.md` references the ADR
- All team members have been notified the ADR is the source of truth for architecture questions
