// src/permissions/settings.ts
// Persists user preferences to <userData>/settings.json — main-process only.

import { app } from 'electron';
import fs from 'fs';
import path from 'path';

interface AppSettings {
  hasShownConsent: boolean;
}

const DEFAULT: AppSettings = { hasShownConsent: false };

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function readSettings(): AppSettings {
  // VERBATIM_RESET_CONSENT=1 forces the consent dialog to appear (dev only)
  if (process.env.VERBATIM_RESET_CONSENT === '1') return { ...DEFAULT };
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    return { ...DEFAULT, ...JSON.parse(raw) } as AppSettings;
  } catch {
    return { ...DEFAULT };
  }
}

export function writeSettings(patch: Partial<AppSettings>): AppSettings {
  const current = readSettings();
  const next = { ...current, ...patch };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}
