// src/__tests__/vad-latency.test.ts
// End-to-end latency test for the Issue 07 streaming pipeline.
//
// Feeds the 10-second speech fixture through NativeSidecarManager and measures
// the wall-clock time from the first speech frame being delivered to the first
// 'partial' transcript event being emitted.
//
// Target: first partial event within 2000ms of first speech frame (Issue 07 AC).
//
// This test requires:
//   - Native addons built: npm run build:native
//   - Models downloaded:   bash scripts/download-model.sh
//   - Platform: macOS or Windows (skip on Linux / CI that lacks addons)

import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const FIXTURE_WAV  = path.join(PROJECT_ROOT, 'test-fixtures/speech-en-10s.wav');
const VAD_ADDON    = path.join(PROJECT_ROOT, 'sidecar/build/Release/VADAddon.node');
const WHISPER_ADDON = path.join(PROJECT_ROOT, 'sidecar/build/Release/WhisperAddon.node');
const VAD_MODEL    = path.join(PROJECT_ROOT, 'models/silero_vad.onnx');
const WHISPER_MODEL = path.join(PROJECT_ROOT, 'models/ggml-base.en.bin');

// ── Skip conditions ───────────────────────────────────────────────────────────

const hasAddons = fs.existsSync(VAD_ADDON) && fs.existsSync(WHISPER_ADDON);
const hasModels = fs.existsSync(VAD_MODEL) && fs.existsSync(WHISPER_MODEL);
const hasFixture = fs.existsSync(FIXTURE_WAV);
const canRun     = hasAddons && hasModels && hasFixture;

// Increase timeout — Whisper inference can take several seconds on CI hardware
const TEST_TIMEOUT_MS = 30_000;

// ── WAV reader ────────────────────────────────────────────────────────────────

function readWavPcm(filePath: string): Int16Array {
  const buf = fs.readFileSync(filePath);
  // Simple WAV parser — skip the 44-byte header (assumes PCM, 16-bit, mono, 16kHz)
  const dataOffset = 44;
  const pcm = new Int16Array(
    buf.buffer,
    buf.byteOffset + dataOffset,
    (buf.byteLength - dataOffset) / 2,
  );
  return pcm;
}

// ── Test ──────────────────────────────────────────────────────────────────────

describe('VAD streaming pipeline — latency', () => {
  (canRun ? it : it.skip)(
    'first partial event arrives within 2000ms of first speech frame',
    async () => {
      // Dynamically import so Jest doesn't fail the whole suite if addons missing
      const { NativeSidecarManager } = await import('../sidecar/NativeSidecarManager');

      const manager = new NativeSidecarManager(WHISPER_MODEL, VAD_MODEL);

      // We feed audio manually by monkey-patching the internal onData.
      // This avoids needing a live audio device while still exercising the
      // full VAD → utterance → Whisper → partial event path.
      let firstSpeechFrameAt: number | null = null;
      let firstPartialAt: number | null = null;

      const partialReceived = new Promise<void>((resolve) => {
        manager.on('message', (msg) => {
          if (msg.type === 'partial' && firstPartialAt === null) {
            firstPartialAt = Date.now();
            resolve();
          }
        });
      });

      // Start the pipeline (spawns Whisper subprocess, loads VAD)
      await manager.start();

      // Inject fixture audio as a stream of AudioChunks (10ms slices @ 16kHz)
      const pcm = readWavPcm(FIXTURE_WAV);
      const CHUNK_SAMPLES = 160; // 10ms per chunk
      const now = Date.now();

      for (let offset = 0; offset + CHUNK_SAMPLES <= pcm.length; offset += CHUNK_SAMPLES) {
        const slice = pcm.subarray(offset, offset + CHUNK_SAMPLES);
        const capturedAt = now + Math.round(offset / 16);  // wall-clock simulation

        // Mark when we send the first frame
        if (offset === 0) firstSpeechFrameAt = Date.now();

        // Call the private onData — cast through any to access it
        (manager as unknown as { onData(c: unknown): void }).onData({
          pcm: Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength),
          capturedAt,
          sampleRate: 16000,
          channels: 1,
          bitDepth: 16,
        });

        // Yield to the event loop between chunks to let promises settle
        await new Promise(r => setImmediate(r));
      }

      // Wait for the first partial (up to TEST_TIMEOUT_MS)
      await partialReceived;
      await manager.stop();

      expect(firstSpeechFrameAt).not.toBeNull();
      expect(firstPartialAt).not.toBeNull();

      const latencyMs = firstPartialAt! - firstSpeechFrameAt!;
      console.log(`[vad-latency] First partial event latency: ${latencyMs}ms`);

      expect(latencyMs).toBeLessThan(2000);
    },
    TEST_TIMEOUT_MS,
  );

  it('skips gracefully when native addons or models are absent', () => {
    if (canRun) {
      console.log('[vad-latency] All dependencies present — full test ran above.');
    } else {
      const missing = [
        !hasAddons  && 'native addons (npm run build:native)',
        !hasModels  && 'model files (bash scripts/download-model.sh)',
        !hasFixture && 'test fixture (test-fixtures/speech-en-10s.wav)',
      ].filter(Boolean);
      console.warn('[vad-latency] Skipped. Missing:', missing.join(', '));
    }
    expect(true).toBe(true);
  });
});
