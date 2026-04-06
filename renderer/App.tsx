import React, { useEffect, useRef, useState } from 'react';
import type { SidecarMessage } from '../src/sidecar/SidecarManager';
import type { CaptureStatus, TranscriptLine } from '../src/session/SessionState';
import type { GeneratedQuestion, SessionContext } from '../src/ai/AIModule';
import type { MacOSPermissionState } from '../src/permissions/MacOSPermissions';
import type { PermissionState } from '../electron/preload';
import QuestionPanel from './components/QuestionPanel';
import ConsentDialog from './components/ConsentDialog';
import PermissionGate from './components/PermissionGate';

// Extend Window to include the context-bridge API
declare global {
  interface Window {
    transcribeAPI: {
      startSession(role: SessionContext['role']): Promise<void>;
      stopSession(): Promise<void>;
      getPermissionState(): Promise<PermissionState>;
      acknowledgeConsent(): Promise<PermissionState>;
      checkPermission(): Promise<{ permissionState: MacOSPermissionState }>;
      openSystemSettings(): Promise<void>;
      onTranscript(callback: (msg: SidecarMessage) => void): () => void;
      onQuestions(callback: (questions: GeneratedQuestion[]) => void): () => void;
      getWsPort(): Promise<number>;
    };
  }
}

let lineCounter = 0;

// ── Design tokens ─────────────────────────────────────────────────────────────

const COLOR: Record<CaptureStatus, string> = {
  idle:      'var(--status-idle)',
  capturing: 'var(--status-capturing)',
  paused:    'var(--status-paused)',
  error:     'var(--status-error)',
};

const PULSE_COLOR: Record<CaptureStatus, string> = {
  idle:      'transparent',
  capturing: 'rgba(34,197,94,0.55)',
  paused:    'rgba(245,158,11,0.55)',
  error:     'rgba(239,68,68,0.55)',
};

const STATUS_LABEL: Record<CaptureStatus, string> = {
  idle:      'Ready',
  capturing: 'Live',
  paused:    'Paused',
  error:     'Error',
};

const ROLES: { value: SessionContext['role']; label: string }[] = [
  { value: 'default',     label: 'Default'    },
  { value: 'interviewer', label: 'Interviewer' },
  { value: 'customer',    label: 'Customer'    },
  { value: 'presenter',   label: 'Presenter'   },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTime(s: number): string {
  const mm = Math.floor(s / 60).toString().padStart(2, '0');
  const ss = (s % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

function wordCount(lines: TranscriptLine[]): number {
  return lines
    .filter(l => l.type === 'final')
    .reduce((n, l) => n + l.text.trim().split(/\s+/).filter(Boolean).length, 0);
}

const WAVE_BARS = Array(16).fill(0);

// ── Component ─────────────────────────────────────────────────────────────────

export default function App() {
  const [status, setStatus]                   = useState<CaptureStatus>('idle');
  const [lines, setLines]                     = useState<TranscriptLine[]>([]);
  const [lastError, setLastError]             = useState<string | null>(null);
  const [sessionSeconds, setSessionSeconds]   = useState(0);
  const [role, setRole]                       = useState<SessionContext['role']>('default');
  const [questions, setQuestions]             = useState<GeneratedQuestion[]>([]);
  const [wsPort, setWsPort]                   = useState<number | null>(null);
  const [hasConsent, setHasConsent]           = useState<boolean | null>(null); // null = loading
  const [permissionState, setPermissionState] = useState<MacOSPermissionState>('granted');
  const [exclusiveModeModal, setExclusiveModeModal] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const timerRef  = useRef<ReturnType<typeof setInterval> | null>(null);

  // Bootstrap: load consent + permission state
  useEffect(() => {
    window.transcribeAPI.getPermissionState().then(({ hasShownConsent, permissionState: ps }) => {
      setHasConsent(hasShownConsent);
      setPermissionState(ps);
    });
    window.transcribeAPI.getWsPort().then(setWsPort);
  }, []);

  // IPC: transcript + question events
  useEffect(() => {
    const offTranscript = window.transcribeAPI.onTranscript((msg: SidecarMessage) => {
      if (msg.type === 'status') {
        setStatus(msg.value as CaptureStatus);
        setLastError(null);
        return;
      }
      if (msg.type === 'error') {
        setStatus('error');
        if (msg.code === 'EXCLUSIVE_MODE') {
          setExclusiveModeModal(true);
        } else {
          setLastError(`[${msg.code}] ${msg.message}`);
        }
        return;
      }
      const line: TranscriptLine = {
        id:        `${++lineCounter}`,
        type:      msg.type,
        text:      msg.text,
        startMs:   msg.startMs,
        endMs:     msg.endMs,
        createdAt: Date.now(),
      };
      setLines(prev => {
        const without = prev.filter(
          l => !(l.type === 'partial' && l.startMs === line.startMs)
        );
        return [...without, line];
      });
    });

    const offQuestions = window.transcribeAPI.onQuestions(setQuestions);

    return () => { offTranscript(); offQuestions(); };
  }, []);

  // Session timer
  useEffect(() => {
    if (status === 'capturing') {
      timerRef.current = setInterval(() => setSessionSeconds(s => s + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      if (status === 'idle') setSessionSeconds(0);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [status]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  const handleConsent = async () => {
    const { permissionState: ps } = await window.transcribeAPI.acknowledgeConsent();
    setHasConsent(true);
    setPermissionState(ps);
  };

  const handleToggle = async () => {
    if (status === 'capturing') {
      await window.transcribeAPI.stopSession();
    } else {
      await window.transcribeAPI.startSession(role);
    }
  };

  const handleClear = () => setLines([]);

  const isCapturing = status === 'capturing';
  const finalLines  = lines.filter(l => l.type === 'final');
  const words       = wordCount(lines);

  // Show loading state until consent/permission are known
  if (hasConsent === null) return null;

  return (
    <div style={s.root}>

      {/* ── First-launch consent ─────────────────────────────────── */}
      {!hasConsent && <ConsentDialog onContinue={handleConsent} />}

      {/* ── EXCLUSIVE_MODE modal ─────────────────────────────────── */}
      {exclusiveModeModal && (
        <div style={s.overlay} role="dialog" aria-modal>
          <div style={s.modalCard}>
            <div style={s.modalIcon} aria-hidden>⚠</div>
            <h3 style={s.modalTitle}>Audio device in exclusive mode</h3>
            <p style={s.modalBody}>
              Another application has exclusive control of your audio device.
              Close any audio apps that may use exclusive mode (e.g. DAWs, games,
              or audio interfaces) and try again.
            </p>
            <div style={s.modalActions}>
              <button style={s.btnModalDismiss} onClick={() => setExclusiveModeModal(false)}>
                Dismiss
              </button>
              <button
                style={s.btnModalRetry}
                onClick={async () => {
                  setExclusiveModeModal(false);
                  await window.transcribeAPI.startSession(role);
                }}
              >
                Try Again
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Header ──────────────────────────────────────────────── */}
      <header style={s.header}>
        <div style={s.headerLeft}>
          <span style={s.appIcon} aria-hidden>◉</span>
          <span style={s.appName}>Verbatim</span>
        </div>

        <div style={s.headerRight}>
          {isCapturing && (
            <span style={s.sessionTimer} aria-label="Session duration">
              {formatTime(sessionSeconds)}
            </span>
          )}
          <div style={s.statusBadge} role="status" aria-live="polite">
            <span
              className={isCapturing || status === 'paused' ? 'dot-pulse' : ''}
              style={{
                ...s.statusDot,
                background: COLOR[status],
                '--pulse-color': PULSE_COLOR[status],
              } as React.CSSProperties}
            />
            <span style={{ ...s.statusText, color: COLOR[status] }}>
              {STATUS_LABEL[status]}
            </span>
          </div>
        </div>
      </header>

      {/* ── Waveform strip ──────────────────────────────────────── */}
      <div style={s.waveStrip}>
        <div
          className={isCapturing ? 'wave-active' : ''}
          style={s.waveContainer}
          aria-hidden
        >
          {WAVE_BARS.map((_, i) => (
            <span
              key={i}
              className="wave-bar"
              style={{
                ...s.waveBar,
                background: isCapturing ? 'var(--accent)' : 'var(--border-bright)',
              }}
            />
          ))}
        </div>

        {lastError && (
          <span style={s.errorPill} title={lastError} role="alert">
            ⚠ {lastError}
          </span>
        )}
      </div>

      {/* ── Content: transcript + question panel ─────────────────── */}
      <div style={s.content}>
        <main className="transcript-area" style={s.transcript}>
          <PermissionGate
            permissionState={permissionState}
            onPermissionChange={setPermissionState}
          >
            {lines.length === 0 ? (
              <div style={s.emptyState}>
                <div style={s.emptyIcon} aria-hidden>⌘</div>
                <div style={s.emptyTitle}>Ready to transcribe</div>
                <div style={s.emptySubtitle}>
                  Click{' '}
                  <strong style={{ color: 'var(--text-secondary)' }}>Start Capturing</strong>{' '}
                  to begin recording system audio
                </div>
              </div>
            ) : (
              lines.map(line => (
                <div
                  key={line.id}
                  className="line-enter"
                  style={{
                    ...s.line,
                    opacity: line.type === 'partial' ? 0.5 : 1,
                  }}
                >
                  <time
                    dateTime={new Date(line.createdAt).toISOString()}
                    style={s.timestamp}
                  >
                    {new Date(line.createdAt).toLocaleTimeString([], {
                      hour:   '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </time>
                  <span
                    className={line.type === 'partial' ? 'partial-cursor' : ''}
                    style={s.lineText}
                  >
                    {line.text}
                  </span>
                </div>
              ))
            )}
          </PermissionGate>
          <div ref={bottomRef} />
        </main>

        <QuestionPanel questions={questions} />
      </div>

      {/* ── Footer ──────────────────────────────────────────────── */}
      <footer style={s.footer}>
        <div style={s.footerLeft}>
          <div style={s.footerStats} aria-live="polite">
            {finalLines.length > 0
              ? `${finalLines.length} ${finalLines.length === 1 ? 'line' : 'lines'} · ${words} ${words === 1 ? 'word' : 'words'}`
              : 'No transcript yet'}
          </div>
          {wsPort !== null && (
            <span style={s.wsPort} title="WebSocket output">
              ws://127.0.0.1:{wsPort}
            </span>
          )}
        </div>

        <div style={s.footerActions}>
          {!isCapturing && (
            <select
              value={role}
              onChange={e => setRole(e.target.value as SessionContext['role'])}
              style={s.roleSelect}
              aria-label="Session role"
            >
              {ROLES.map(r => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          )}
          {lines.length > 0 && !isCapturing && (
            <button
              className="btn-ghost"
              onClick={handleClear}
              style={s.btnClear}
              aria-label="Clear transcript"
            >
              Clear
            </button>
          )}
          <button
            className="btn-action"
            onClick={handleToggle}
            style={isCapturing ? s.btnStop : s.btnStart}
            aria-label={isCapturing ? 'Stop capturing' : 'Start capturing'}
          >
            {isCapturing ? '■  Stop' : '▶  Start Capturing'}
          </button>
        </div>
      </footer>

    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: {
    display:       'flex',
    flexDirection: 'column',
    height:        '100vh',
    background:    'var(--bg)',
    color:         'var(--text-primary)',
    fontFamily:    'var(--font-ui)',
    overflow:      'hidden',
  },

  // ── Modals
  overlay: {
    position:       'fixed',
    inset:          0,
    background:     'rgba(0,0,0,0.55)',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    zIndex:         100,
    backdropFilter: 'blur(4px)',
  },
  modalCard: {
    background:    'var(--surface)',
    border:        '1px solid var(--border-bright)',
    borderRadius:  14,
    padding:       '28px 24px 20px',
    maxWidth:      360,
    width:         '90%',
    display:       'flex',
    flexDirection: 'column',
    gap:           12,
    boxShadow:     '0 24px 60px rgba(0,0,0,0.35)',
  },
  modalIcon: { fontSize: 24, textAlign: 'center' as const },
  modalTitle: {
    fontSize:      15,
    fontWeight:    600,
    color:         'var(--text-primary)',
    margin:        0,
    textAlign:     'center',
    letterSpacing: '-0.015em',
  },
  modalBody: {
    fontSize:   13,
    color:      'var(--text-secondary)',
    lineHeight: 1.6,
    margin:     0,
    textAlign:  'center',
  },
  modalActions: {
    display:        'flex',
    justifyContent: 'center',
    gap:            8,
    marginTop:      4,
  },
  btnModalDismiss: {
    padding:      '8px 18px',
    border:       '1px solid var(--border-bright)',
    borderRadius: 8,
    background:   'transparent',
    color:        'var(--text-secondary)',
    fontSize:     12,
    fontWeight:   500,
    cursor:       'pointer',
    fontFamily:   'var(--font-ui)',
  },
  btnModalRetry: {
    padding:      '8px 18px',
    border:       'none',
    borderRadius: 8,
    background:   'var(--accent)',
    color:        '#fff',
    fontSize:     12,
    fontWeight:   600,
    cursor:       'pointer',
    fontFamily:   'var(--font-ui)',
  },

  // ── Header
  header: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    padding:        '0 20px',
    height:         52,
    background:     'var(--surface)',
    borderBottom:   '1px solid var(--border)',
    flexShrink:     0,
  },
  headerLeft:  { display: 'flex', alignItems: 'center', gap: 9 },
  appIcon:     { fontSize: 17, color: 'var(--accent)', lineHeight: 1 },
  appName:     { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.01em' },
  headerRight: { display: 'flex', alignItems: 'center', gap: 14 },
  sessionTimer: {
    fontFamily:    'var(--font-mono)',
    fontSize:      11,
    color:         'var(--text-secondary)',
    letterSpacing: '0.06em',
  },
  statusBadge: {
    display:      'flex',
    alignItems:   'center',
    gap:          7,
    padding:      '4px 11px',
    background:   'var(--surface-raised)',
    border:       '1px solid var(--border-bright)',
    borderRadius: 20,
  },
  statusDot: {
    width: 7, height: 7, borderRadius: '50%', display: 'inline-block', flexShrink: 0,
  },
  statusText: {
    fontSize: 11, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase',
  },

  // ── Waveform
  waveStrip: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    padding:        '0 20px',
    height:         44,
    background:     'var(--surface)',
    borderBottom:   '1px solid var(--border)',
    flexShrink:     0,
  },
  waveContainer: { display: 'flex', alignItems: 'center', gap: 3, height: '100%' },
  waveBar: {
    width: 3, height: 3, borderRadius: 2, display: 'inline-block',
    flexShrink: 0, transition: 'background 0.4s',
  },
  errorPill: {
    display:      'inline-flex',
    alignItems:   'center',
    gap:          6,
    padding:      '4px 11px',
    background:   'rgba(239,68,68,0.09)',
    border:       '1px solid rgba(239,68,68,0.22)',
    borderRadius: 20,
    fontSize:     11,
    color:        'var(--status-error)',
    maxWidth:     380,
    overflow:     'hidden',
    textOverflow: 'ellipsis',
    whiteSpace:   'nowrap',
    cursor:       'default',
  },

  // ── Content
  content:    { flex: 1, display: 'flex', overflow: 'hidden' },
  transcript: {
    flex:          1,
    overflowY:     'auto',
    padding:       '18px 24px',
    display:       'flex',
    flexDirection: 'column',
    gap:           1,
  },
  emptyState: {
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    justifyContent: 'center',
    flex:           1,
    gap:            10,
    paddingTop:     48,
    userSelect:     'none',
  },
  emptyIcon:     { fontSize: 30, color: 'var(--text-muted)', marginBottom: 2 },
  emptyTitle:    { fontSize: 14, fontWeight: 500, color: 'var(--text-secondary)' },
  emptySubtitle: { fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', maxWidth: 260, lineHeight: 1.6 },
  line: {
    display: 'flex', gap: 16, padding: '5px 8px', borderRadius: 6,
    lineHeight: 1.65, alignItems: 'baseline', transition: 'background 0.12s',
  },
  timestamp: {
    fontFamily:    'var(--font-mono)',
    fontSize:      10,
    color:         'var(--text-secondary)',
    flexShrink:    0,
    paddingTop:    2,
    letterSpacing: '0.04em',
    minWidth:      68,
  },
  lineText: {
    fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-primary)',
    lineHeight: 1.65, letterSpacing: '-0.01em',
  },

  // ── Footer
  footer: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    padding:        '0 20px',
    height:         52,
    background:     'var(--surface)',
    borderTop:      '1px solid var(--border)',
    flexShrink:     0,
  },
  footerLeft:  { display: 'flex', flexDirection: 'column', gap: 2 },
  footerStats: { fontSize: 11, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', letterSpacing: '0.02em' },
  wsPort:      { fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.02em', userSelect: 'text', cursor: 'default' },
  footerActions: { display: 'flex', gap: 8, alignItems: 'center' },
  roleSelect: {
    padding:    '5px 8px',
    border:     '1px solid var(--border-bright)',
    borderRadius: 7,
    background: 'var(--surface-raised)',
    color:      'var(--text-secondary)',
    fontSize:   12,
    fontFamily: 'var(--font-ui)',
    cursor:     'pointer',
    outline:    'none',
  },
  btnClear: {
    padding:      '6px 14px',
    border:       '1px solid var(--border-bright)',
    borderRadius: 7,
    background:   'transparent',
    color:        'var(--text-secondary)',
    fontSize:     12,
    fontWeight:   500,
    cursor:       'pointer',
    fontFamily:   'var(--font-ui)',
  },
  btnStart: {
    padding:      '7px 18px',
    border:       'none',
    borderRadius: 7,
    background:   'var(--accent)',
    color:        '#fff',
    fontSize:     12,
    fontWeight:   600,
    cursor:       'pointer',
    fontFamily:   'var(--font-ui)',
    letterSpacing: '0.01em',
    boxShadow:    '0 0 18px var(--accent-glow)',
  },
  btnStop: {
    padding:      '7px 18px',
    border:       '1px solid rgba(239,68,68,0.28)',
    borderRadius: 7,
    background:   'rgba(239,68,68,0.12)',
    color:        'var(--status-error)',
    fontSize:     12,
    fontWeight:   600,
    cursor:       'pointer',
    fontFamily:   'var(--font-ui)',
    letterSpacing: '0.01em',
  },
};
