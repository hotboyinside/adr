// renderer/components/QuestionPanel.tsx
// Displays AI-generated questions from the session AI module.
// Placeholder state for Issue 08 — populated by the real AI module in a future slice.

import React from 'react';
import type { GeneratedQuestion } from '../../src/ai/AIModule';

interface Props {
  questions: GeneratedQuestion[];
}

export default function QuestionPanel({ questions }: Props) {
  return (
    <aside style={s.panel}>
      <div style={s.header}>
        <span style={s.headerIcon} aria-hidden>◈</span>
        <span style={s.headerTitle}>Questions</span>
      </div>

      <div style={s.body}>
        {questions.length === 0 ? (
          <div style={s.empty}>
            <div style={s.emptyIcon} aria-hidden>✦</div>
            <div style={s.emptyText}>Questions will appear here as the conversation progresses</div>
          </div>
        ) : (
          questions.map((q, i) => (
            <div key={i} style={s.question}>
              <div style={s.questionText}>{q.text}</div>
              {q.rationale && (
                <div style={s.rationale}>{q.rationale}</div>
              )}
              <div style={s.confidence}>
                <span style={{ ...s.confidenceBar, width: `${q.confidence * 100}%` }} />
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

const s: Record<string, React.CSSProperties> = {
  panel: {
    width:           220,
    flexShrink:      0,
    display:         'flex',
    flexDirection:   'column',
    borderLeft:      '1px solid var(--border)',
    background:      'var(--surface)',
    overflow:        'hidden',
  },
  header: {
    display:      'flex',
    alignItems:   'center',
    gap:          7,
    padding:      '0 14px',
    height:       40,
    borderBottom: '1px solid var(--border)',
    flexShrink:   0,
  },
  headerIcon: {
    fontSize: 12,
    color:    'var(--accent)',
  },
  headerTitle: {
    fontSize:      11,
    fontWeight:    600,
    letterSpacing: '0.07em',
    textTransform: 'uppercase',
    color:         'var(--text-secondary)',
  },
  body: {
    flex:      1,
    overflowY: 'auto',
    padding:   '12px 10px',
    display:   'flex',
    flexDirection: 'column',
    gap:       8,
  },
  empty: {
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    justifyContent: 'center',
    flex:           1,
    gap:            8,
    paddingTop:     32,
    userSelect:     'none',
    textAlign:      'center',
  },
  emptyIcon: {
    fontSize: 20,
    color:    'var(--text-muted)',
  },
  emptyText: {
    fontSize:   11,
    color:      'var(--text-muted)',
    lineHeight: 1.6,
    maxWidth:   160,
  },
  question: {
    padding:      '9px 10px',
    borderRadius: 7,
    background:   'var(--surface-raised)',
    border:       '1px solid var(--border-bright)',
    display:      'flex',
    flexDirection:'column',
    gap:          4,
  },
  questionText: {
    fontSize:   12,
    color:      'var(--text-primary)',
    lineHeight: 1.5,
  },
  rationale: {
    fontSize:   10,
    color:      'var(--text-muted)',
    lineHeight: 1.4,
  },
  confidence: {
    height:       3,
    background:   'var(--border-bright)',
    borderRadius: 2,
    overflow:     'hidden',
    marginTop:    2,
  },
  confidenceBar: {
    display:      'block',
    height:       '100%',
    background:   'var(--accent)',
    borderRadius: 2,
  },
};
