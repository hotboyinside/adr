// src/sidecar/whisper-subprocess.ts
// Runs in a child_process.fork(). Owns the WhisperAddon and handles all
// transcription requests via Node.js IPC (process.send / process.on('message')).
// Completely isolated from Electron's address space — no Chromium memory conflicts.
// See Issue 06 fix.

import path from 'path';

export interface TranscribeRequest {
  type: 'transcribe';
  id: number;
  pcm: Buffer;       // s16le, 16 kHz, mono
  startMs: number;
  endMs: number;
}

export interface TranscribeResponse {
  type: 'result' | 'error';
  id: number;
  json?: string;      // present when type === 'result'
  message?: string;   // present when type === 'error'
}

export interface ReadyMessage {
  type: 'ready';
}

// ── Bootstrap (only runs when this file is the main module) ────────────────

if (require.main === module) {
  const PROJECT_ROOT = path.resolve(__dirname, '../../..');

  const addonPath  = path.join(PROJECT_ROOT, 'sidecar/build/Release/WhisperAddon.node');
  const modelPath  = process.env.WHISPER_MODEL_PATH
    ?? path.join(PROJECT_ROOT, 'models/ggml-base.en.bin');

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { WhisperAddon } = require(addonPath) as {
    WhisperAddon: new (modelPath: string) => {
      transcribe(pcm: Buffer, startMs: number, endMs: number): Promise<string>;
      isLoaded(): boolean;
    };
  };

  let whisper: ReturnType<typeof WhisperAddon['prototype']['constructor']>;
  try {
    whisper = new WhisperAddon(modelPath);
  } catch (err) {
    process.stderr.write(`[whisper-subprocess] Failed to load model: ${err}\n`);
    process.exit(1);
  }

  // Signal ready to the parent
  process.send!({ type: 'ready' } satisfies ReadyMessage);

  process.on('message', async (msg: TranscribeRequest) => {
    if (msg.type !== 'transcribe') return;

    // Reconstruct Buffer from the deserialized object (IPC serialises Buffers)
    const pcm = Buffer.isBuffer(msg.pcm)
      ? msg.pcm
      : Buffer.from((msg.pcm as any).data ?? msg.pcm);

    try {
      const json = await whisper.transcribe(pcm, msg.startMs, msg.endMs);
      const response: TranscribeResponse = { type: 'result', id: msg.id, json };
      process.send!(response);
    } catch (err) {
      const response: TranscribeResponse = {
        type: 'error', id: msg.id, message: String(err),
      };
      process.send!(response);
    }
  });
}
