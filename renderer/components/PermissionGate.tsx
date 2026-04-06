// renderer/components/PermissionGate.tsx
// Guards session start behind the macOS Screen Recording permission.
// Renders different content based on the current permission state.

import React, { useState } from 'react';
import type { MacOSPermissionState } from '../../src/permissions/MacOSPermissions';

interface Props {
  permissionState: MacOSPermissionState;
  onPermissionChange(state: MacOSPermissionState): void;
  children: React.ReactNode;
}

export default function PermissionGate({ permissionState, onPermissionChange, children }: Props) {
  const [checking, setChecking] = useState(false);

  if (permissionState === 'granted') {
    return <>{children}</>;
  }

  const handleOpenSettings = async () => {
    await window.transcribeAPI.openSystemSettings();
  };

  const handleCheckAgain = async () => {
    setChecking(true);
    try {
      const { permissionState: next } = await window.transcribeAPI.checkPermission();
      onPermissionChange(next);
    } finally {
      setChecking(false);
    }
  };

  if (permissionState === 'denied') {
    return (
      <div style={s.gate} data-testid="permission-denied">
        <div style={s.icon} aria-hidden>🔒</div>
        <h3 style={s.title}>Screen Recording permission required</h3>
        <p style={s.body}>
          Verbatim needs the <strong>Screen Recording</strong> permission to capture
          system audio. You previously denied this request.
        </p>
        <p style={s.body}>
          Open <strong>System Settings → Privacy &amp; Security → Screen Recording</strong>{' '}
          and enable Verbatim, then return here.
        </p>
        <div style={s.actions}>
          <button style={s.btnSecondary} onClick={handleCheckAgain} disabled={checking}>
            {checking ? 'Checking…' : 'Check Again'}
          </button>
          <button style={s.btnPrimary} onClick={handleOpenSettings}>
            Open System Settings
          </button>
        </div>
      </div>
    );
  }

  // 'not-determined' — permission not yet requested
  return (
    <div style={s.gate} data-testid="permission-not-determined">
      <div style={s.icon} aria-hidden>🎙</div>
      <h3 style={s.title}>Permission needed</h3>
      <p style={s.body}>
        Verbatim will ask for <strong>Screen Recording</strong> permission when you
        start your first session. This is required to capture system audio on macOS.
      </p>
      <p style={s.body}>
        Click <strong>Start Capturing</strong> below to continue.
      </p>
      {children}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  gate: {
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    justifyContent: 'center',
    flex:           1,
    padding:        '40px 32px',
    gap:            14,
    textAlign:      'center',
    userSelect:     'none',
  },
  icon: {
    fontSize:     32,
    marginBottom: 4,
  },
  title: {
    fontSize:      15,
    fontWeight:    600,
    color:         'var(--text-primary)',
    margin:        0,
    letterSpacing: '-0.015em',
  },
  body: {
    fontSize:   13,
    color:      'var(--text-secondary)',
    lineHeight: 1.65,
    margin:     0,
    maxWidth:   340,
  },
  actions: {
    display:   'flex',
    gap:       8,
    marginTop: 8,
  },
  btnPrimary: {
    padding:      '8px 20px',
    border:       'none',
    borderRadius: 8,
    background:   'var(--accent)',
    color:        '#fff',
    fontSize:     12,
    fontWeight:   600,
    cursor:       'pointer',
    fontFamily:   'var(--font-ui)',
  },
  btnSecondary: {
    padding:      '8px 16px',
    border:       '1px solid var(--border-bright)',
    borderRadius: 8,
    background:   'transparent',
    color:        'var(--text-secondary)',
    fontSize:     12,
    fontWeight:   500,
    cursor:       'pointer',
    fontFamily:   'var(--font-ui)',
  },
};
