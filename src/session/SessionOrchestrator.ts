// src/session/SessionOrchestrator.ts
// Routes transcript events from the sidecar to the AI module and forwards
// AI-generated questions to the renderer. Also broadcasts all session events
// to the WebSocket output server for external consumers.

import { randomUUID } from 'crypto';
import type { SidecarManager } from '../sidecar/SidecarManager';
import type { AIModule, GeneratedQuestion, SessionContext } from '../ai/AIModule';
import type { WebSocketOutputServer } from '../ipc/WebSocketOutputServer';

export class SessionOrchestrator {
  private sessionId: string = '';

  constructor(
    private readonly sidecar: SidecarManager,
    private readonly ai: AIModule,
    private readonly sendQuestions: (questions: GeneratedQuestion[]) => void,
    private readonly ws?: WebSocketOutputServer,
  ) {
    sidecar.on('message', (msg) => {
      if (msg.type === 'partial' || msg.type === 'final') {
        this.ai.onTranscript(msg);
        this.ws?.broadcast({
          event:     'transcript',
          sessionId: this.sessionId,
          type:      msg.type,
          text:      msg.text,
          startMs:   msg.startMs,
          endMs:     msg.endMs,
          segments:  [],
        });
      }

      if (msg.type === 'error') {
        this.ws?.broadcast({ event: 'error', code: msg.code, message: msg.message });
      }
    });

    ai.on('questions', (questions) => {
      this.sendQuestions(questions);
      this.ws?.broadcast({ event: 'questions', sessionId: this.sessionId, questions });
    });
  }

  async startSession(context: SessionContext): Promise<void> {
    this.sessionId = randomUUID();
    this.ai.onSessionStart(context);
    this.ws?.broadcast({
      event:     'session:started',
      sessionId: this.sessionId,
      role:      context.role,
      startedAt: Date.now(),
    });
    await this.sidecar.start();
  }

  async stopSession(): Promise<void> {
    await this.sidecar.stop();
    this.ai.onSessionEnd();
    this.ws?.broadcast({
      event:     'session:stopped',
      sessionId: this.sessionId,
      stoppedAt: Date.now(),
    });
  }
}
