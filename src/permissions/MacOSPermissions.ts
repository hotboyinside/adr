// src/permissions/MacOSPermissions.ts
// macOS Screen Recording permission helpers — main-process only.
// Uses Electron's systemPreferences API which wraps CGPreflightScreenCaptureAccess().

import { systemPreferences, shell } from 'electron';

export type MacOSPermissionState = 'granted' | 'not-determined' | 'denied';

const SETTINGS_DEEP_LINK =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

export function checkScreenRecordingPermission(): MacOSPermissionState {
  // VERBATIM_DEV_PERMISSION=not-determined|denied overrides the real OS check (dev only)
  const devOverride = process.env.VERBATIM_DEV_PERMISSION as MacOSPermissionState | undefined;
  if (devOverride === 'not-determined' || devOverride === 'denied') return devOverride;

  if (process.platform !== 'darwin') return 'granted';

  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'granted') return 'granted';
  if (status === 'denied' || status === 'restricted') return 'denied';
  return 'not-determined';
}

export async function openSystemSettings(): Promise<void> {
  await shell.openExternal(SETTINGS_DEEP_LINK);
}
