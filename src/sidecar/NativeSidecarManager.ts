// src/sidecar/NativeSidecarManager.ts
// Real SidecarManager implementation — wires native audio capture → Whisper.
// Whisper runs in a child_process.fork() subprocess to avoid SIGBUS crashes
// caused by whisper.cpp's large buffer allocations conflicting with Chromium's
// memory layout inside Electron's main process. See Issue 06.

import { EventEmitter } from 'events';
import { spawn, execFileSync, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { SidecarManager, SidecarMessage } from './SidecarManager';
import type { AudioChunk } from '../capture/AudioCapture';
import type { TranscribeRequest, TranscribeResponse, ReadyMessage } from './whisper-subprocess';

// ── Native addon types ──────────────────────────────────────────────────────

interface CaptureAddonCtor {
  new (
    onData: (chunk: AudioChunk) => void,
    onError: (err: { code: string; message: string }) => void,
    onStopped: () => void
  ): CaptureAddonInstance;
}
interface CaptureAddonInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ── Configuration ───────────────────────────────────────────────────────────

// Accumulate this many seconds of audio before flushing to Whisper (batch mode)
const BATCH_DURATION_SEC = 5;
const OUTPUT_SAMPLE_RATE  = 16000;
const BATCH_SAMPLES       = BATCH_DURATION_SEC * OUTPUT_SAMPLE_RATE;

// ── Helpers ─────────────────────────────────────────────────────────────────

// __dirname at runtime = dist/src/sidecar/ — three levels up reaches project root
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

function loadAddon<T>(name: string): T {
  const addonPath = path.join(PROJECT_ROOT, 'sidecar/build/Release', `${name}.node`);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(addonPath) as T;
}

function defaultModelPath(): string {
  return path.join(PROJECT_ROOT, 'models/ggml-base.en.bin');
}

// ── NativeSidecarManager ────────────────────────────────────────────────────

export class NativeSidecarManager extends EventEmitter implements SidecarManager {
  private capture: CaptureAddonInstance | null = null;
  private whisperProc: ChildProcess | null = null;

  // PCM accumulation buffer (s16le samples, 16 kHz, mono)
  private accBuf: Int16Array = new Int16Array(0);
  private accStartMs = 0;
  private sessionStartMs = 0;

  // Pending transcription callbacks keyed by request id
  private pending = new Map<number, { resolve: (json: string) => void; reject: (err: Error) => void }>();
  private nextId = 0;

  constructor(private modelPath = defaultModelPath()) {
    super();
  }

  async start(): Promise<void> {
    this.sessionStartMs = Date.now();
    this.accBuf         = new Int16Array(0);
    this.accStartMs     = 0;

    // Spawn Whisper subprocess — isolated from Electron's address space
    await this.spawnWhisperProcess();

    // Load platform capture addon
    let CaptureAddon: CaptureAddonCtor;
    try {
      if (process.platform === 'darwin') {
        const mod = loadAddon<{ MacOSAudioCapture: CaptureAddonCtor }>('MacOSAudioCapture');
        CaptureAddon = mod.MacOSAudioCapture;
      } else if (process.platform === 'win32') {
        const mod = loadAddon<{ WindowsAudioCapture: CaptureAddonCtor }>('WindowsAudioCapture');
        CaptureAddon = mod.WindowsAudioCapture;
      } else {
        this.emitMsg({ type: 'error', code: 'UNSUPPORTED_PLATFORM',
          message: `Platform ${process.platform} is not supported yet` });
        return;
      }
    } catch (err) {
      this.emitMsg({ type: 'error', code: 'ADDON_LOAD_FAILED', message: String(err) });
      return;
    }

    this.capture = new CaptureAddon(
      (chunk) => this.onData(chunk),
      (err)   => this.emitMsg({ type: 'error', code: err.code, message: err.message }),
      ()      => this.emit('exit', 0)
    );

    await this.capture.start();
    this.emitMsg({ type: 'status', value: 'capturing' });
  }

  async stop(): Promise<void> {
    if (this.capture) {
      await this.capture.stop();
      this.capture = null;
    }
    // Flush any remaining buffered audio
    this.flush(Date.now());

    this.emitMsg({ type: 'status', value: 'idle' });
    this.emit('exit', 0);
  }

  send(_command: string): void {
    // Reserved for future control commands (pause, language change, etc.)
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private flushing = false;

  /**
   * Returns the path to the system Node.js binary.
   * child_process.fork() in Electron uses the Electron binary, which initialises
   * enough Chromium infrastructure (PartitionAlloc) to cause SIGBUS in whisper.cpp.
   * Spawning with the system Node.js avoids this entirely.
   */
  private findSystemNode(): string {
    const whichBin = process.platform === 'win32' ? 'where.exe' : '/usr/bin/which';
    try {
      const result = execFileSync(whichBin, ['node'], {
        encoding: 'utf8',
        env: process.env,
      }).trim();
      // `where.exe` may return multiple lines on Windows; take first
      return result.split('\n')[0].trim();
    } catch {
      const candidates = process.platform === 'win32'
        ? ['C:\\Program Files\\nodejs\\node.exe']
        : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
      for (const p of candidates) {
        if (fs.existsSync(p)) return p;
      }
      throw new Error('System Node.js binary not found — cannot spawn Whisper subprocess');
    }
  }

  /** Spawns whisper-subprocess.js under the system Node.js and waits for 'ready'. */
  private spawnWhisperProcess(): Promise<void> {
    return new Promise((resolve, reject) => {
      const subprocessPath = path.join(__dirname, 'whisper-subprocess.js');

      let nodeBinary: string;
      try {
        nodeBinary = this.findSystemNode();
      } catch (err) {
        const msg = String(err);
        this.emitMsg({ type: 'error', code: 'SUBPROCESS_SPAWN_FAILED', message: msg });
        reject(new Error(msg));
        return;
      }

      // stdio: ['pipe','pipe','pipe','ipc'] sets up the IPC channel on fd 3.
      // System Node.js detects NODE_CHANNEL_FD and makes process.send() available.
      // serialization:'advanced' uses structured clone instead of JSON, so Buffers
      // are transferred as binary (not as 480KB JSON arrays) — faster and unambiguous.
      const child = spawn(nodeBinary, [subprocessPath], {
        env: { ...process.env, WHISPER_MODEL_PATH: this.modelPath },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        serialization: 'advanced',
      } as Parameters<typeof spawn>[2]);

      // Forward subprocess stderr to Electron's terminal for debugging
      child.stderr?.on('data', (data: Buffer) => {
        process.stderr.write(`[whisper-worker] ${data}`);
      });

      this.whisperProc = child;

      const onMessage = (msg: ReadyMessage | TranscribeResponse) => {
        if (msg.type === 'ready') {
          child.off('message', onMessage);
          // Wire up the ongoing response handler
          child.on('message', (m) => this.onSubprocessMessage(m as TranscribeResponse));
          resolve();
          return;
        }
      };

      child.on('message', onMessage);

      child.on('error', (err) => {
        this.emitMsg({ type: 'error', code: 'SUBPROCESS_ERROR', message: String(err) });
        reject(err);
      });

      child.on('exit', (code, signal) => {
        this.whisperProc = null;
        // Reject any in-flight requests
        for (const [, { reject: rej }] of this.pending) {
          rej(new Error(`Whisper subprocess exited (code=${code}, signal=${signal})`));
        }
        this.pending.clear();
      });
    });
  }

  private onSubprocessMessage(msg: TranscribeResponse): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);

    if (msg.type === 'result' && msg.json !== undefined) {
      entry.resolve(msg.json);
    } else {
      entry.reject(new Error(msg.message ?? 'Unknown transcription error'));
    }
  }

  private transcribe(pcm: Buffer, startMs: number, endMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.whisperProc) {
        reject(new Error('Whisper subprocess not running'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const req: TranscribeRequest = { type: 'transcribe', id, pcm, startMs, endMs };
      this.whisperProc.send(req);
    });
  }

  private onData(chunk: AudioChunk): void {
    // chunk.pcm is a Buffer of int16 samples (normalized by the C++ layer)
    const incoming = new Int16Array(
      chunk.pcm.buffer,
      chunk.pcm.byteOffset,
      chunk.pcm.byteLength / 2
    );

    if (this.accBuf.length === 0) {
      this.accStartMs = chunk.capturedAt;
    }

    // Append to accumulation buffer
    const merged = new Int16Array(this.accBuf.length + incoming.length);
    merged.set(this.accBuf);
    merged.set(incoming, this.accBuf.length);
    this.accBuf = merged;

    if (this.accBuf.length >= BATCH_SAMPLES && !this.flushing) {
      this.flush(chunk.capturedAt);
    }
  }

  private flush(endTs: number): void {
    if (this.accBuf.length === 0 || !this.whisperProc || this.flushing) return;

    const pcm     = Buffer.from(this.accBuf.buffer.slice(0));
    const startMs = Math.round(this.accStartMs - this.sessionStartMs);
    const endMs   = Math.round(endTs - this.sessionStartMs);

    // Reset accumulator immediately so capture continues while inference runs
    this.accBuf     = new Int16Array(0);
    this.accStartMs = 0;
    this.flushing   = true;

    this.transcribe(pcm, startMs, endMs)
      .then(json => {
        const result = JSON.parse(json) as SidecarMessage;
        if ((result as { text?: string }).text?.trim()) {
          this.emitMsg(result);
        }
      })
      .catch(err => {
        this.emitMsg({ type: 'error', code: 'TRANSCRIBE_ERROR', message: String(err) });
      })
      .finally(() => {
        this.flushing = false;
      });
  }

  private emitMsg(msg: SidecarMessage): void {
    this.emit('message', msg);
  }
}
