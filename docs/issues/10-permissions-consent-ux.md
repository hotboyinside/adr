# Issue 10 — Permissions & User Consent UX

**Type:** AFK
**Blocked by:** Issues 03a (macOS capture), 03b (Windows capture)
**Priority:** Required before any user-facing release

---

## Description

Implement the permission request flows and user consent experience for both macOS and Windows. No audio capture should begin before the user has explicitly granted consent. This slice covers:

- First-launch consent dialog (what the app captures and why)
- macOS Screen Recording permission request and status handling
- Windows exclusive-mode error guidance
- A persistent visual indicator that capture is active
- Graceful handling of permission denial and revocation

---

## macOS: Screen Recording Permission

ScreenCaptureKit requires the `Screen Recording` permission. This is a one-time system dialog — once granted, it persists across app launches until the user revokes it in System Settings.

### Permission States

```typescript
type MacOSPermissionState =
  | 'granted'       // capture can start immediately
  | 'not-determined' // first launch — must request
  | 'denied';       // user declined — show guidance
```

### Flow

```
App launch
  └── check CGPreflightScreenCaptureAccess()
        ├── granted       → proceed to idle state
        ├── not-determined → show consent dialog → request permission
        │                         ├── granted → proceed
        │                         └── denied  → show "How to enable" screen
        └── denied        → show "How to enable" screen (no re-request — OS handles it)
```

### "How to Enable" Screen
When denied, show a modal with:
- Plain-language explanation of why the permission is needed
- A "Open System Settings" button that calls `shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')`
- A "Check Again" button that re-checks permission status without re-requesting

### Permission Check on Session Start
Even after initial grant, check permission before every `startSession()` call — the user may have revoked it in System Settings while the app was running.

---

## Windows: No Permission Required, But Error Guidance

WASAPI loopback requires no special permission. However, two failure conditions need clear user guidance:

### Exclusive Mode
```
Error: EXCLUSIVE_MODE
  → Show modal: "Another application has exclusive control of your audio device.
                 Close any audio applications that may be using exclusive mode
                 (e.g. some DAWs, games, or audio interfaces) and try again."
  → "Try Again" button → retry startSession()
```

### Device Lost
```
Error: DEVICE_LOST
  → Show toast: "Audio device disconnected. Reconnect your device and try again."
  → Auto-retry after 3 seconds if a device becomes available
```

---

## First-Launch Consent Dialog

Shown on the very first launch (before any permission request), regardless of platform.

```
┌─────────────────────────────────────────────┐
│  🎙 Aura captures your system audio         │
│                                             │
│  To generate real-time transcriptions,      │
│  Aura needs access to your system audio     │
│  output — the audio your speakers play.     │
│                                             │
│  • Audio is processed locally on your Mac   │
│  • Nothing is sent to external servers      │
│  • You can stop capture at any time         │
│                                             │
│  [Learn more]          [Continue]           │
└─────────────────────────────────────────────┘
```

Store `hasShownConsent: true` in Electron's `app.getPath('userData')/settings.json` after the user clicks Continue. Never show it again.

---

## Active Capture Indicator

While a session is active, two visible indicators must be present:

1. **System tray icon** — changes to an animated/highlighted variant (e.g. a pulsing dot) when capturing
2. **Menu bar tooltip** — "Aura — Capturing audio" when hovering over the tray icon

On macOS, also set the Dock badge to "●" while capturing (optional but recommended).

These indicators are the user's primary signal that audio capture is active. They must be impossible to miss.

---

## Tasks

### macOS
- [ ] Implement `src/permissions/MacOSPermissions.ts`
  - [ ] `checkScreenRecordingPermission()` → `MacOSPermissionState` (calls native via N-API or `@electron/remote`)
  - [ ] `requestScreenRecordingPermission()` → opens system dialog
  - [ ] `openSystemSettings()` → deep link to Screen Recording prefs
- [ ] Add permission check to app startup sequence in `electron/main.ts`
- [ ] Implement `PermissionGate` renderer component: shown before session can start if permission is not `granted`
- [ ] Implement "How to Enable" screen in the renderer

### Windows
- [ ] Implement `EXCLUSIVE_MODE` error modal in the renderer (triggered by sidecar error event)
- [ ] Implement `DEVICE_LOST` toast with 3-second auto-retry logic in `SessionOrchestrator`

### Both Platforms
- [ ] Implement first-launch consent dialog (renderer component)
- [ ] Persist `hasShownConsent` to `settings.json` via Electron `app.getPath('userData')`
- [ ] Implement active capture indicator:
  - [ ] Tray icon swap (idle icon → active icon) in `electron/tray.ts`
  - [ ] Tray tooltip update
- [ ] Gate `startSession()` behind both consent flag and permission state checks
- [ ] Write unit tests for `PermissionGate` component:
  - [ ] Renders permission prompt when state is `not-determined`
  - [ ] Renders "How to Enable" when state is `denied`
  - [ ] Renders children (session UI) when state is `granted`

---

## Acceptance Criteria

- First-launch consent dialog appears exactly once (never again after clicking Continue)
- On macOS: Screen Recording permission dialog is triggered on first session start; if denied, "How to Enable" screen is shown with a working "Open System Settings" link
- On Windows: EXCLUSIVE_MODE and DEVICE_LOST errors show clear, actionable guidance
- Audio capture never begins without `hasShownConsent === true` and `permission === 'granted'`
- Tray icon changes state visibly when a session is active vs idle
- `PermissionGate` unit tests pass
- No audio capture occurs in any code path that bypasses the consent and permission checks
