// SidecarManager interface — defined in Issue 02, stable per ADR-001.
// MockSidecarManager is used during UI development without a real sidecar binary.

import { EventEmitter } from 'events';

export type SidecarMessage =
  | { type: 'partial' | 'final'; text: string; startMs: number; endMs: number }
  | { type: 'status'; value: 'capturing' | 'idle' | 'paused' }
  | { type: 'error'; code: string; message: string };

export interface SidecarManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(command: string): void;
  on(event: 'message', listener: (msg: SidecarMessage) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
}

// ---------------------------------------------------------------------------
// Mock implementation — emits fake transcript events every 2 seconds.
// Replace with the real sidecar implementation in Slices 03a / 03b.
// ---------------------------------------------------------------------------

const MOCK_LINES = [
  'The quick brown fox jumps over the lazy dog.',
  'System audio capture is initializing.',
  'Whisper model loaded successfully.',
  'Real-time transcription is now active.',
  'Voice activity detected — processing utterance.',
  'End of utterance detected — emitting final transcript.',
];

export class MockSidecarManager extends EventEmitter implements SidecarManager {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lineIndex = 0;
  private startMs = 0;

  async start(): Promise<void> {
    this.startMs = Date.now();
    this.emit('message', { type: 'status', value: 'capturing' } satisfies SidecarMessage);

    this.timer = setInterval(() => {
      const now = Date.now();
      const text = MOCK_LINES[this.lineIndex % MOCK_LINES.length];
      this.lineIndex++;

      // emit a partial first, then final ~500 ms later
      const partial: SidecarMessage = {
        type: 'partial',
        text: text.slice(0, Math.floor(text.length / 2)) + '…',
        startMs: now - this.startMs,
        endMs: now - this.startMs + 500,
      };
      this.emit('message', partial);

      setTimeout(() => {
        const final: SidecarMessage = {
          type: 'final',
          text,
          startMs: now - this.startMs,
          endMs: Date.now() - this.startMs,
        };
        this.emit('message', final);
      }, 500);
    }, 2000);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit('message', { type: 'status', value: 'idle' } satisfies SidecarMessage);
    this.emit('exit', 0);
  }

  send(_command: string): void {
    // no-op in mock
  }
}
