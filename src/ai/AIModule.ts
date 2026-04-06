// AIModule interface — defined in ADR-001 Section 7.
// The real implementation (local LLM via Ollama or cloud API) replaces
// NoOpAIModule in a dedicated slice without changing any other layer.

import { EventEmitter } from 'events';

export interface SessionContext {
  role: 'interviewer' | 'customer' | 'presenter' | 'default';
  domain?: string;
}

export interface TranscriptEvent {
  type: 'partial' | 'final';
  text: string;
  startMs: number;
  endMs: number;
}

export interface GeneratedQuestion {
  text: string;
  rationale?: string;  // why this question is relevant
  confidence: number;  // 0.0–1.0
}

export interface AIModule {
  onSessionStart(context: SessionContext): void;
  onTranscript(event: TranscriptEvent): void;
  onSessionEnd(): void;
  on(event: 'questions', listener: (questions: GeneratedQuestion[]) => void): this;
}

// ---------------------------------------------------------------------------
// No-op stub — registered at startup; replaced by real AI module later.
// ---------------------------------------------------------------------------

export class NoOpAIModule extends EventEmitter implements AIModule {
  onSessionStart(_context: SessionContext): void {}
  onTranscript(_event: TranscriptEvent): void {}
  onSessionEnd(): void {}
}
