// src/sidecar/NativeSidecarManager.ts
// Real SidecarManager — wires native audio capture → Silero VAD → Whisper.
//
// Pipeline (Issue 07):
//   AudioChunk (16kHz mono s16le from capture addon)
//     → 512-sample frames → SileroVAD (via VADAddon.node)
//     → utterance buffer (speech frames + silence padding)
//     → WhisperTranscriber subprocess (Issue 06) → partial / final events
//
// Whisper runs in a child_process.fork() subprocess to avoid the SIGBUS crash
// caused by whisper.cpp's large allocation patterns inside Electron/Chromium.

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

interface VadAddonCtor {
  new (modelPath: string): VadAddonInstance;
}
interface VadAddonInstance {
  /** Process exactly kFrameSamples int16 samples. Returns probability [0,1]. */
  process(frame: Buffer): number;
  reset(): void;
}

// ── VAD / utterance configuration ───────────────────────────────────────────
// These mirror the constexpr values in SileroVAD.h and the Issue 07 spec.

const OUTPUT_SAMPLE_RATE    = 16_000;
const kFrameSamples         = 512;       // 32ms at 16kHz — must match SileroVAD::kFrameSize
const kSpeechThreshold      = 0.5;
const kSilencePaddingMs     = 300;
const kMinUtteranceMs       = 500;
const kMaxUtteranceMs       = 15_000;
const kPartialIntervalMs    = 500;       // emit a partial every 500ms of active speech

const kSilencePaddingFrames = Math.ceil(kSilencePaddingMs / (kFrameSamples / OUTPUT_SAMPLE_RATE * 1000));
const kMinUtteranceSamples  = (kMinUtteranceMs  / 1000) * OUTPUT_SAMPLE_RATE;
const kMaxUtteranceSamples  = (kMaxUtteranceMs  / 1000) * OUTPUT_SAMPLE_RATE;

// ── Helpers ─────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '../../..');

function loadAddon<T>(name: string): T {
  const addonPath = path.join(PROJECT_ROOT, 'sidecar/build/Release', `${name}.node`);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(addonPath) as T;
}

function defaultModelPath(): string {
  return path.join(PROJECT_ROOT, 'models/ggml-base.en.bin');
}

function defaultVadModelPath(): string {
  return path.join(PROJECT_ROOT, 'models/silero_vad.onnx');
}

// ── NativeSidecarManager ────────────────────────────────────────────────────

export class NativeSidecarManager extends EventEmitter implements SidecarManager {
  private capture: CaptureAddonInstance | null = null;
  private vad: VadAddonInstance | null = null;
  private whisperProc: ChildProcess | null = null;

  // ── Whisper IPC bookkeeping
  private pending = new Map<number, { resolve: (json: string) => void; reject: (err: Error) => void }>();
  private nextId = 0;

  // ── Session timing
  private sessionStartMs = 0;

  // ── Utterance / VAD state
  private utteranceBuf: Int16Array = new Int16Array(0);
  private utteranceStartMs = 0;  // wall-clock ms of first speech frame in buffer
  private silenceFrames = 0;
  private speechActive = false;

  // Accumulates samples that didn't fill a complete 512-sample VAD frame.
  // Chunks from the capture addon are often shorter than kFrameSamples (e.g.
  // ScreenCaptureKit delivers ~160-256 samples per callback), so we must
  // carry the remainder across chunks before calling vad.process().
  private frameAccumulator: Int16Array = new Int16Array(0);

  // ── Partial emission
  private partialTimer: ReturnType<typeof setInterval> | null = null;
  // Incremented each time we reset the utterance; guards against stale partials.
  private utteranceGeneration = 0;

  // ── Transcription serialization
  // WhisperAddon rejects concurrent calls, so we allow only one in-flight
  // transcription at a time. Partials are dropped when busy; finals are queued
  // (last-write-wins) and drained in the .finally() handler.
  private transcribing = false;
  private queuedFinal: { pcm: Buffer; startMs: number; endMs: number } | null = null;

  constructor(
    private modelPath    = defaultModelPath(),
    private vadModelPath = defaultVadModelPath(),
  ) {
    super();
  }

  async start(): Promise<void> {
    this.sessionStartMs = Date.now();
    this.resetUtterance();

    // Spawn Whisper subprocess first (isolated from Chromium's address space)
    await this.spawnWhisperProcess();

    // Load VAD addon
    let VadAddon: VadAddonCtor;
    try {
      const mod = loadAddon<{ SileroVAD: VadAddonCtor }>('VADAddon');
      VadAddon = mod.SileroVAD;
    } catch (err) {
      this.emitMsg({ type: 'error', code: 'VAD_LOAD_FAILED', message: String(err) });
      return;
    }
    try {
      this.vad = new VadAddon(this.vadModelPath);
    } catch (err) {
      this.emitMsg({ type: 'error', code: 'VAD_INIT_FAILED', message: String(err) });
      return;
    }

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
    this.stopPartialTimer();

    // Flush whatever is in the utterance buffer
    if (this.utteranceBuf.length >= kMinUtteranceSamples) {
      this.flushUtterance(Date.now());
    }

    this.vad?.reset();
    this.vad = null;

    this.emitMsg({ type: 'status', value: 'idle' });
    this.emit('exit', 0);
  }

  send(_command: string): void {
    // Reserved for future control commands (pause, language switch)
  }

  // ── Audio processing ──────────────────────────────────────────────────────

  private onData(chunk: AudioChunk): void {
    if (!this.vad) return;

    const incoming = new Int16Array(
      chunk.pcm.buffer,
      chunk.pcm.byteOffset,
      chunk.pcm.byteLength / 2,
    );

    // Prepend any leftover samples from the previous chunk so that short
    // capture callbacks (e.g. ~160 samples from ScreenCaptureKit) are
    // assembled into complete 512-sample VAD frames before processing.
    let samples: Int16Array;
    if (this.frameAccumulator.length > 0) {
      const merged = new Int16Array(this.frameAccumulator.length + incoming.length);
      merged.set(this.frameAccumulator);
      merged.set(incoming, this.frameAccumulator.length);
      samples = merged;
      this.frameAccumulator = new Int16Array(0);
    } else {
      samples = incoming;
    }

    let offset = 0;
    while (offset + kFrameSamples <= samples.length) {
      const frameSlice = samples.subarray(offset, offset + kFrameSamples);
      offset += kFrameSamples;

      // process() expects a Buffer of int16 bytes (kFrameSamples * 2 bytes)
      const frameBuf = Buffer.from(frameSlice.buffer, frameSlice.byteOffset, frameSlice.byteLength);
      const prob = this.vad.process(frameBuf);
      const speech = prob >= kSpeechThreshold;

      if (speech) {
        if (!this.speechActive) {
          // Transition: silence → speech
          this.speechActive = true;
          this.silenceFrames = 0;
          if (this.utteranceBuf.length === 0) {
            // Timestamp the start of this utterance
            this.utteranceStartMs = chunk.capturedAt - (incoming.length - offset) / OUTPUT_SAMPLE_RATE * 1000;
          }
          this.startPartialTimer();
        }
        this.appendToUtterance(frameSlice);

        // Force-flush if utterance has grown too long
        if (this.utteranceBuf.length >= kMaxUtteranceSamples) {
          this.flushUtterance(chunk.capturedAt);
        }
      } else {
        // Silence frame
        if (this.speechActive) {
          // Append silence padding so utterance ends naturally, not mid-word
          this.appendToUtterance(frameSlice);
          this.silenceFrames++;

          if (this.silenceFrames >= kSilencePaddingFrames) {
            // Enough trailing silence — end of utterance
            this.speechActive = false;
            this.flushUtterance(chunk.capturedAt);
          }
        }
        // Silence while not in a speech segment: ignore
      }
    }

    // Save any remaining samples (< kFrameSamples) for the next chunk
    const remaining = samples.length - offset;
    if (remaining > 0) {
      this.frameAccumulator = samples.slice(offset);
    }
  }

  // ── Utterance buffer helpers ──────────────────────────────────────────────

  private appendToUtterance(frame: Int16Array): void {
    const merged = new Int16Array(this.utteranceBuf.length + frame.length);
    merged.set(this.utteranceBuf);
    merged.set(frame, this.utteranceBuf.length);
    this.utteranceBuf = merged;
  }

  private resetUtterance(): void {
    this.utteranceGeneration++;   // invalidates any in-flight partial transcriptions
    this.utteranceBuf     = new Int16Array(0);
    this.utteranceStartMs = 0;
    this.silenceFrames    = 0;
    this.speechActive     = false;
    this.frameAccumulator = new Int16Array(0);
    this.queuedFinal      = null; // discard any queued final for the old utterance
    this.stopPartialTimer();
    this.vad?.reset();
  }

  private flushUtterance(endWallMs: number): void {
    const buf = this.utteranceBuf;

    if (buf.length < kMinUtteranceSamples) {
      // Utterance too short (likely noise) — discard silently
      this.resetUtterance();
      return;
    }

    const startMs = Math.max(0, Math.round(this.utteranceStartMs - this.sessionStartMs));
    const endMs   = Math.round(endWallMs - this.sessionStartMs);
    const pcm     = Buffer.from(buf.buffer.slice(0));

    // Reset now so new speech can begin while Whisper is processing
    this.resetUtterance();

    this.transcribeFinal(pcm, startMs, endMs);
  }

  // ── Partial emission ──────────────────────────────────────────────────────

  private startPartialTimer(): void {
    if (this.partialTimer) return;
    const myGeneration = this.utteranceGeneration;

    this.partialTimer = setInterval(() => {
      // Guard: if the utterance was reset (flushed), this timer is stale
      if (myGeneration !== this.utteranceGeneration) {
        this.stopPartialTimer();
        return;
      }
      if (this.utteranceBuf.length < kMinUtteranceSamples) return;

      const pcm     = Buffer.from(this.utteranceBuf.buffer.slice(0));
      const startMs = Math.max(0, Math.round(this.utteranceStartMs - this.sessionStartMs));
      const gen     = this.utteranceGeneration;

      this.transcribePartial(pcm, startMs, gen);
    }, kPartialIntervalMs);
  }

  private stopPartialTimer(): void {
    if (this.partialTimer) {
      clearInterval(this.partialTimer);
      this.partialTimer = null;
    }
  }

  // ── Serialized transcription helpers ─────────────────────────────────────

  private transcribeFinal(pcm: Buffer, startMs: number, endMs: number): void {
    if (this.transcribing) {
      // Replace any previously queued final — last utterance wins
      this.queuedFinal = { pcm, startMs, endMs };
      return;
    }
    this._doTranscribe(pcm, startMs, endMs, true);
  }

  private transcribePartial(pcm: Buffer, startMs: number, gen: number): void {
    // Drop the partial if Whisper is busy or a final is already waiting
    if (this.transcribing || this.queuedFinal !== null) return;
    this._doTranscribe(pcm, startMs, 0, false, gen);
  }

  private _doTranscribe(
    pcm: Buffer, startMs: number, endMs: number,
    isFinal: boolean, gen?: number,
  ): void {
    this.transcribing = true;
    this.transcribe(pcm, startMs, endMs)
      .then(json => {
        const { text = '' } = JSON.parse(json) as { text?: string };
        if (!text.trim()) return;
        if (!isFinal && gen !== this.utteranceGeneration) return; // stale partial
        this.emitMsg({ type: isFinal ? 'final' : 'partial', text, startMs, endMs: isFinal ? endMs : 0 });
      })
      .catch(err => {
        if (isFinal) {
          this.emitMsg({ type: 'error', code: 'TRANSCRIBE_ERROR', message: String(err) });
        }
        // partial errors are silently dropped — the timer will retry next tick
      })
      .finally(() => {
        this.transcribing = false;
        const deferred = this.queuedFinal;
        if (deferred) {
          this.queuedFinal = null;
          this._doTranscribe(deferred.pcm, deferred.startMs, deferred.endMs, true);
        }
      });
  }

  // ── Whisper subprocess ────────────────────────────────────────────────────

  private findSystemNode(): string {
    const whichBin = process.platform === 'win32' ? 'where.exe' : '/usr/bin/which';
    try {
      const result = execFileSync(whichBin, ['node'], {
        encoding: 'utf8',
        env: process.env,
      }).trim();
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

      const child = spawn(nodeBinary, [subprocessPath], {
        env: { ...process.env, WHISPER_MODEL_PATH: this.modelPath },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        serialization: 'advanced',
      } as Parameters<typeof spawn>[2]);

      child.stderr?.on('data', (data: Buffer) => {
        process.stderr.write(`[whisper-worker] ${data}`);
      });

      this.whisperProc = child;

      const onReady = (msg: ReadyMessage | TranscribeResponse) => {
        if (msg.type === 'ready') {
          child.off('message', onReady);
          child.on('message', (m) => this.onSubprocessMessage(m as TranscribeResponse));
          resolve();
        }
      };
      child.on('message', onReady);

      child.on('error', (err) => {
        this.emitMsg({ type: 'error', code: 'SUBPROCESS_ERROR', message: String(err) });
        reject(err);
      });

      child.on('exit', (code, signal) => {
        this.whisperProc = null;
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

  private emitMsg(msg: SidecarMessage): void {
    this.emit('message', msg);
  }
}
