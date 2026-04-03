import type { SessionContext } from '../ai/AIModule';

export type CaptureStatus = 'idle' | 'capturing' | 'paused' | 'error';

export interface TranscriptLine {
  id: string;
  type: 'partial' | 'final';
  text: string;
  startMs: number;
  endMs: number;
  createdAt: number; // Unix timestamp ms
}

export interface SessionState {
  status: CaptureStatus;
  context: SessionContext;
  transcript: TranscriptLine[];
  errorMessage?: string;
}

export const DEFAULT_SESSION_STATE: SessionState = {
  status: 'idle',
  context: { role: 'default' },
  transcript: [],
};
