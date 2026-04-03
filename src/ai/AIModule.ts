// AIModule interface — defined in ADR-001 Section 7.
// The real implementation (local LLM via Ollama or cloud API) replaces
// NoOpAIModule in a dedicated slice without changing any other layer.

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

export interface AIModule {
  onSessionStart(context: SessionContext): void;
  onTranscript(event: TranscriptEvent): void;
  onSessionEnd(): void;
}

// ---------------------------------------------------------------------------
// No-op stub — registered at startup; replaced by real AI module later.
// ---------------------------------------------------------------------------

export class NoOpAIModule implements AIModule {
  onSessionStart(_context: SessionContext): void {}
  onTranscript(_event: TranscriptEvent): void {}
  onSessionEnd(): void {}
}
