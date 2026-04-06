// src/__tests__/session-orchestrator.test.ts
// Unit test for SessionOrchestrator (Issue 08).
// Verifies that transcript events are correctly routed to the AI module
// and that NoOpAIModule never emits 'questions' events.

import { EventEmitter } from 'events';
import { SessionOrchestrator } from '../session/SessionOrchestrator';
import { NoOpAIModule } from '../ai/AIModule';
import type { SidecarManager, SidecarMessage } from '../sidecar/SidecarManager';
import type { SessionContext } from '../ai/AIModule';

// ── Mock SidecarManager ───────────────────────────────────────────────────────

class MockSidecar extends EventEmitter implements SidecarManager {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  send(_cmd: string): void {}

  emit(event: 'message', msg: SidecarMessage): boolean;
  emit(event: 'exit', code: number): boolean;
  emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SessionOrchestrator', () => {
  let sidecar: MockSidecar;
  let ai: NoOpAIModule;
  let sendQuestions: jest.Mock;
  let orchestrator: SessionOrchestrator;

  beforeEach(() => {
    sidecar       = new MockSidecar();
    ai            = new NoOpAIModule();
    sendQuestions = jest.fn();
    orchestrator  = new SessionOrchestrator(sidecar, ai, sendQuestions);
  });

  it('routes final transcript events to the AI module', () => {
    const spy = jest.spyOn(ai, 'onTranscript');
    const msg: SidecarMessage = {
      type: 'final', text: 'Hello world', startMs: 0, endMs: 1000,
    };
    sidecar.emit('message', msg);
    expect(spy).toHaveBeenCalledWith({ type: 'final', text: 'Hello world', startMs: 0, endMs: 1000 });
  });

  it('routes partial transcript events to the AI module', () => {
    const spy = jest.spyOn(ai, 'onTranscript');
    const msg: SidecarMessage = {
      type: 'partial', text: 'Hell…', startMs: 0, endMs: 0,
    };
    sidecar.emit('message', msg);
    expect(spy).toHaveBeenCalledWith({ type: 'partial', text: 'Hell…', startMs: 0, endMs: 0 });
  });

  it('does not route status or error messages to the AI module', () => {
    const spy = jest.spyOn(ai, 'onTranscript');
    sidecar.emit('message', { type: 'status', value: 'capturing' });
    sidecar.emit('message', { type: 'error', code: 'ERR', message: 'oops' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('NoOpAIModule never emits questions events', () => {
    const questionsListener = jest.fn();
    ai.on('questions', questionsListener);
    ai.onSessionStart({ role: 'default' });
    ai.onTranscript({ type: 'final', text: 'test', startMs: 0, endMs: 500 });
    ai.onSessionEnd();
    expect(questionsListener).not.toHaveBeenCalled();
  });

  it('sendQuestions callback is not called by NoOpAIModule', () => {
    const context: SessionContext = { role: 'interviewer' };
    orchestrator.startSession(context);
    sidecar.emit('message', { type: 'final', text: 'Tell me about yourself', startMs: 0, endMs: 2000 });
    expect(sendQuestions).not.toHaveBeenCalled();
  });

  it('calls ai.onSessionStart with the provided context', async () => {
    const spy     = jest.spyOn(ai, 'onSessionStart');
    const context: SessionContext = { role: 'presenter', domain: 'engineering' };
    await orchestrator.startSession(context);
    expect(spy).toHaveBeenCalledWith(context);
  });

  it('calls ai.onSessionEnd when stopSession is called', async () => {
    const spy = jest.spyOn(ai, 'onSessionEnd');
    await orchestrator.stopSession();
    expect(spy).toHaveBeenCalled();
  });

  it('forwards questions from AI module to sendQuestions callback', () => {
    const questions = [{ text: 'What is your experience?', confidence: 0.9 }];
    ai.emit('questions', questions);
    expect(sendQuestions).toHaveBeenCalledWith(questions);
  });
});
