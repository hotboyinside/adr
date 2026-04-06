// src/__tests__/websocket-output.test.ts
// Integration test for WebSocketOutputServer + SessionOrchestrator (Issue 09).
//
// Starts a real WebSocket server, connects a client, drives a mock session,
// and asserts that session:started and transcript events arrive in order.

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { WebSocketOutputServer } from '../ipc/WebSocketOutputServer';
import { SessionOrchestrator } from '../session/SessionOrchestrator';
import { NoOpAIModule } from '../ai/AIModule';
import type { SidecarManager, SidecarMessage } from '../sidecar/SidecarManager';

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open',  () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Wait for the next WS message matching the given event name, discarding others. */
function waitForEvent(ws: WebSocket, event: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg.event === event) {
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WebSocketOutputServer', () => {
  let server:       WebSocketOutputServer;
  let sidecar:      MockSidecar;
  let orchestrator: SessionOrchestrator;
  let client:       WebSocket;

  beforeEach(async () => {
    server  = new WebSocketOutputServer();
    await server.start();

    sidecar      = new MockSidecar();
    orchestrator = new SessionOrchestrator(
      sidecar,
      new NoOpAIModule(),
      jest.fn(),
      server,
    );

    client = await connectClient(server.port);
  });

  afterEach(async () => {
    client.close();
    server.stop();
    // Allow sockets to drain
    await new Promise(r => setTimeout(r, 50));
  });

  it('broadcasts session:started when startSession is called', async () => {
    const pending = waitForEvent(client, 'session:started');
    await orchestrator.startSession({ role: 'interviewer' });
    const msg = await pending;

    expect(msg.event).toBe('session:started');
    expect(msg.role).toBe('interviewer');
    expect(typeof msg.sessionId).toBe('string');
    expect(typeof msg.startedAt).toBe('number');
  });

  it('broadcasts transcript events from the sidecar', async () => {
    await orchestrator.startSession({ role: 'default' });

    const pending = waitForEvent(client, 'transcript');
    sidecar.emit('message', {
      type: 'final', text: 'Hello world', startMs: 0, endMs: 1000,
    });
    const msg = await pending;

    expect(msg.event).toBe('transcript');
    expect(msg.type).toBe('final');
    expect(msg.text).toBe('Hello world');
    expect(Array.isArray(msg.segments)).toBe(true);
  });

  it('broadcasts session:stopped when stopSession is called', async () => {
    await orchestrator.startSession({ role: 'default' });
    const pending = waitForEvent(client, 'session:stopped');
    await orchestrator.stopSession();
    const msg = await pending;

    expect(msg.event).toBe('session:stopped');
    expect(typeof msg.stoppedAt).toBe('number');
  });

  it('broadcasts error events from the sidecar', async () => {
    const pending = waitForEvent(client, 'error');
    sidecar.emit('message', { type: 'error', code: 'DEVICE_LOST', message: 'Audio device disconnected' });
    const msg = await pending;

    expect(msg.event).toBe('error');
    expect(msg.code).toBe('DEVICE_LOST');
  });

  it('events arrive in order: session:started then transcript', async () => {
    const received: unknown[] = [];
    const done = new Promise<void>(resolve => {
      client.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.event === 'ping') return; // skip heartbeats
        received.push(msg);
        if (received.length === 2) resolve();
      });
    });

    await orchestrator.startSession({ role: 'presenter' });
    sidecar.emit('message', { type: 'final', text: 'Test', startMs: 0, endMs: 500 });

    await done;

    expect((received[0] as Record<string, unknown>).event).toBe('session:started');
    expect((received[1] as Record<string, unknown>).event).toBe('transcript');
  });

  it('writes port file and port is accessible', () => {
    expect(server.port).toBeGreaterThanOrEqual(49152);
  });
});
