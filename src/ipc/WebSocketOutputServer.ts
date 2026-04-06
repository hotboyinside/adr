// src/ipc/WebSocketOutputServer.ts
// Local-only WebSocket server that broadcasts real-time transcript and session
// events to external consumers (browser extensions, companion apps, dev tools).
//
// Binds to 127.0.0.1 only — never reachable from other machines.
// Resolves port from 49152 upwards if the default is occupied.
// Writes the resolved port to ~/.verbatim/ws.port for consumer discovery.

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';

// ── Types ────────────────────────────────────────────────────────────────────

export type WsEvent =
  | { event: 'transcript';      sessionId: string; type: 'partial' | 'final'; text: string; startMs: number; endMs: number; segments: { startMs: number; endMs: number; text: string }[] }
  | { event: 'session:started'; sessionId: string; role: string; startedAt: number }
  | { event: 'session:stopped'; sessionId: string; stoppedAt: number }
  | { event: 'questions';       sessionId: string; questions: unknown[] }
  | { event: 'error';           code: string; message: string }
  | { event: 'ping';            ts: number };

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PORT    = 49152;
const HEARTBEAT_MS    = 5_000;
const PORT_FILE_DIR   = path.join(os.homedir(), '.verbatim');
const PORT_FILE       = path.join(PORT_FILE_DIR, 'ws.port');

// ── Helpers ──────────────────────────────────────────────────────────────────

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(); resolve(true); });
    server.listen(port, '127.0.0.1');
  });
}

async function findFreePort(start: number): Promise<number> {
  for (let port = start; port < start + 50; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in range ${start}–${start + 49}`);
}

function writePortFile(port: number): void {
  fs.mkdirSync(PORT_FILE_DIR, { recursive: true });
  fs.writeFileSync(PORT_FILE, String(port), 'utf8');
}

function deletePortFile(): void {
  try { fs.unlinkSync(PORT_FILE); } catch { /* ignore if already gone */ }
}

// ── WebSocketOutputServer ────────────────────────────────────────────────────

export class WebSocketOutputServer {
  private wss:       WebSocketServer | null = null;
  private clients  = new Set<WebSocket>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  public  port     = 0;

  async start(): Promise<void> {
    this.port = await findFreePort(DEFAULT_PORT);

    await new Promise<void>((resolve, reject) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: this.port });
      wss.once('listening', () => { this.wss = wss; resolve(); });
      wss.once('error', reject);
    });

    this.wss!.on('connection', (ws) => {
      this.clients.add(ws);
      console.log(`[ws] client connected (total: ${this.clients.size})`);
      ws.on('close', () => { this.clients.delete(ws); });
      ws.on('error', () => { this.clients.delete(ws); });
    });

    writePortFile(this.port);
    console.log(`[ws] server listening on ws://127.0.0.1:${this.port}`);

    this.heartbeat = setInterval(() => {
      this.broadcast({ event: 'ping', ts: Date.now() });
      // Prune sockets that are no longer open
      for (const ws of this.clients) {
        if (ws.readyState !== WebSocket.OPEN) this.clients.delete(ws);
      }
    }, HEARTBEAT_MS);
  }

  broadcast(event: WsEvent): void {
    if (!this.wss) return;
    const payload = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  stop(): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    deletePortFile();
    for (const ws of this.clients) ws.terminate();
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
    console.log('[ws] server stopped');
  }
}

export { randomUUID };
