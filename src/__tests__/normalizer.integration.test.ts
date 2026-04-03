// src/__tests__/normalizer.integration.test.ts
// TypeScript integration test for the native Normalizer addon (Issue 05).
// Feeds synthetic PCM through the native normalizer and verifies:
//   - Output sample rate is 16000 Hz
//   - Output is mono (1 channel)
//   - Output is s16le (2 bytes/sample)
//   - Output duration matches input duration (within ±1 ms)

import * as path from 'path';

// The NormalizerAddon built by cmake-js
const addonPath = path.resolve(__dirname, '../../sidecar/build/Release/NormalizerAddon.node');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalize } = require(addonPath) as {
  normalize(pcm: Buffer, sampleRate: number, channels: number, bitDepth: number): Buffer;
};

// ── Helpers ────────────────────────────────────────────────────────────────

function makeStereoF32Sine(sampleRate: number, freqHz: number, durationSec: number): Buffer {
  const frames = Math.floor(sampleRate * durationSec);
  const buf = Buffer.allocUnsafe(frames * 2 * 4); // stereo float32
  for (let i = 0; i < frames; i++) {
    const sample = Math.sin(2 * Math.PI * freqHz * i / sampleRate);
    buf.writeFloatLE(sample, (i * 2 + 0) * 4); // L
    buf.writeFloatLE(sample, (i * 2 + 1) * 4); // R
  }
  return buf;
}

function durationMs(sampleCount: number, sampleRate: number): number {
  return (sampleCount / sampleRate) * 1000;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('NormalizerAddon integration', () => {
  const INPUT_RATE = 48000;
  const DURATION_SEC = 1.0;

  it('outputs s16le buffer from f32le stereo input', () => {
    const pcm = makeStereoF32Sine(INPUT_RATE, 440, DURATION_SEC);
    const out = normalize(pcm, INPUT_RATE, 2, 32);

    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.byteLength).toBeGreaterThan(0);
    // s16le = 2 bytes per sample
    expect(out.byteLength % 2).toBe(0);
  });

  it('output duration matches input duration within ±1 ms', () => {
    const pcm = makeStereoF32Sine(INPUT_RATE, 440, DURATION_SEC);
    const out = normalize(pcm, INPUT_RATE, 2, 32);

    const outputSamples = out.byteLength / 2; // int16 = 2 bytes
    const inputDurationMs  = DURATION_SEC * 1000;
    const outputDurationMs = durationMs(outputSamples, 16000);

    expect(Math.abs(outputDurationMs - inputDurationMs)).toBeLessThanOrEqual(1);
  });

  it('normalizes 44100 Hz stereo input', () => {
    const pcm = makeStereoF32Sine(44100, 440, 0.5);
    const out = normalize(pcm, 44100, 2, 32);

    const outputSamples    = out.byteLength / 2;
    const outputDurationMs = durationMs(outputSamples, 16000);
    expect(Math.abs(outputDurationMs - 500)).toBeLessThanOrEqual(1);
  });

  it('pass-through: 16kHz mono s16le produces correct sample count', () => {
    const frames = 16000; // 1 second
    const pcm = Buffer.allocUnsafe(frames * 2);
    for (let i = 0; i < frames; i++) {
      pcm.writeInt16LE(Math.floor(Math.sin(2 * Math.PI * 440 * i / 16000) * 32767), i * 2);
    }

    const out = normalize(pcm, 16000, 1, 16);
    expect(out.byteLength / 2).toBe(frames);
  });
});
