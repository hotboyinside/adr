// renderer/components/ConsentDialog.tsx
// First-launch consent modal. Shown exactly once — before any permission
// request — regardless of platform. After the user clicks Continue the
// main process writes hasShownConsent=true to settings.json.

import React from 'react';

interface Props {
  onContinue(): void;
}

export default function ConsentDialog({ onContinue }: Props) {
  return (
    <div style={s.overlay} role="dialog" aria-modal aria-labelledby="consent-title">
      <div style={s.card}>
        <div style={s.icon} aria-hidden>◉</div>

        <h2 id="consent-title" style={s.title}>
          Verbatim captures your system audio
        </h2>

        <p style={s.body}>
          To generate real-time transcriptions, Verbatim needs access to your
          system audio output — the audio your speakers play.
        </p>

        <ul style={s.list}>
          <li style={s.listItem}>Audio is processed locally on your device</li>
          <li style={s.listItem}>Nothing is sent to external servers</li>
          <li style={s.listItem}>You can stop capture at any time</li>
        </ul>

        <div style={s.actions}>
          <button
            style={s.btnContinue}
            onClick={onContinue}
            autoFocus
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  overlay: {
    position:        'fixed',
    inset:           0,
    background:      'rgba(0,0,0,0.55)',
    display:         'flex',
    alignItems:      'center',
    justifyContent:  'center',
    zIndex:          100,
    backdropFilter:  'blur(4px)',
  },
  card: {
    background:   'var(--surface)',
    border:       '1px solid var(--border-bright)',
    borderRadius: 14,
    padding:      '32px 28px 24px',
    maxWidth:     380,
    width:        '90%',
    display:      'flex',
    flexDirection:'column',
    gap:          14,
    boxShadow:    '0 24px 60px rgba(0,0,0,0.35)',
  },
  icon: {
    fontSize:  28,
    color:     'var(--accent)',
    textAlign: 'center',
  },
  title: {
    fontSize:      16,
    fontWeight:    600,
    color:         'var(--text-primary)',
    margin:        0,
    textAlign:     'center',
    letterSpacing: '-0.02em',
    lineHeight:    1.3,
  },
  body: {
    fontSize:   13,
    color:      'var(--text-secondary)',
    lineHeight: 1.6,
    margin:     0,
    textAlign:  'center',
  },
  list: {
    listStyle:   'none',
    margin:      0,
    padding:     '4px 0',
    display:     'flex',
    flexDirection:'column',
    gap:         6,
  },
  listItem: {
    fontSize:    12,
    color:       'var(--text-secondary)',
    paddingLeft: 20,
    position:    'relative',
    lineHeight:  1.5,
  },
  actions: {
    display:        'flex',
    justifyContent: 'center',
    marginTop:      4,
  },
  btnContinue: {
    padding:       '9px 32px',
    border:        'none',
    borderRadius:  8,
    background:    'var(--accent)',
    color:         '#fff',
    fontSize:      13,
    fontWeight:    600,
    cursor:        'pointer',
    fontFamily:    'var(--font-ui)',
    boxShadow:     '0 0 18px var(--accent-glow)',
    letterSpacing: '0.01em',
  },
};
