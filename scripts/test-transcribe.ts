// scripts/test-transcribe.ts
// Smoke-test: feeds a WAV file directly through WhisperAddon and prints the transcript.
// Usage: npx ts-node scripts/test-transcribe.ts [path/to/audio.wav]
// Default: test-fixtures/speech-en-10s.wav
// See Issue 06 acceptance criteria.

import fs from 'fs';
import path from 'path';

// ── Load native addon ───────────────────────────────────────────────────────

const addonPath = path.resolve(__dirname, '../sidecar/build/Release/WhisperAddon.node');
if (!fs.existsSync(addonPath)) {
  console.error(`WhisperAddon not found at ${addonPath}`);
  console.error('Run: npm run build:native');
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WhisperAddon } = require(addonPath) as {
  WhisperAddon: new (modelPath: string) => {
    transcribe(pcm: Buffer, startMs: number, endMs: number): string;
    isLoaded(): boolean;
  };
};

const modelPath = path.resolve(__dirname, '../models/ggml-base.en.bin');
if (!fs.existsSync(modelPath)) {
  console.error(`Model not found at ${modelPath}`);
  console.error('Run: bash scripts/download-model.sh');
  process.exit(1);
}

// ── WAV parsing ─────────────────────────────────────────────────────────────

interface WavInfo {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  pcmOffset: number;
  pcmLength: number;
}

function parseWav(buf: Buffer): WavInfo {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a valid WAV file');
  }

  let offset = 12;
  let pcmOffset = -1;
  let pcmLength = -1;
  let sampleRate = 0;
  let channels = 0;
  let bitDepth = 0;

  while (offset < buf.length - 8) {
    const chunkId  = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    offset += 8;

    if (chunkId === 'fmt ') {
      channels   = buf.readUInt16LE(offset + 2);
      sampleRate = buf.readUInt32LE(offset + 4);
      bitDepth   = buf.readUInt16LE(offset + 14);
    } else if (chunkId === 'data') {
      pcmOffset = offset;
      pcmLength = chunkSize;
      break;
    }

    offset += chunkSize;
  }

  if (pcmOffset < 0) throw new Error('No data chunk found in WAV file');
  return { sampleRate, channels, bitDepth, pcmOffset, pcmLength };
}

// ── Normalise PCM to s16le 16 kHz mono (simple integer downsampler) ─────────
// For the smoke test we load the NormalizerAddon if available, else naive.

function normalizePcm(
  raw: Buffer,
  info: WavInfo
): Buffer {
  const normAddonPath = path.resolve(__dirname, '../sidecar/build/Release/NormalizerAddon.node');
  if (fs.existsSync(normAddonPath)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { normalize } = require(normAddonPath) as {
      normalize(pcm: Buffer, sr: number, ch: number, bd: number): Buffer;
    };
    return normalize(raw, info.sampleRate, info.channels, info.bitDepth);
  }
  // Fallback: assume already s16le 16 kHz mono
  return raw;
}

// ── Main ─────────────────────────────────────────────────────────────────────

void (async () => {

const wavPath = process.argv[2]
  ?? path.resolve(__dirname, '../test-fixtures/speech-en-10s.wav');

if (!fs.existsSync(wavPath)) {
  console.error(`WAV file not found: ${wavPath}`);
  process.exit(1);
}

console.log(`Loading model from ${modelPath} ...`);
const whisper = new WhisperAddon(modelPath);
if (!whisper.isLoaded()) {
  console.error('Model failed to load');
  process.exit(1);
}
console.log('Model loaded.');

const wavBuf = fs.readFileSync(wavPath);
const info   = parseWav(wavBuf);
const raw    = wavBuf.slice(info.pcmOffset, info.pcmOffset + info.pcmLength);

console.log(`Input: ${info.sampleRate} Hz, ${info.channels} ch, ${info.bitDepth}-bit`);
console.log('Normalizing...');
const normalized = normalizePcm(raw, info);
const durationSec = (normalized.byteLength / 2) / 16000;
console.log(`Normalized: ${normalized.byteLength} bytes, ~${durationSec.toFixed(1)} s`);

console.log('Transcribing...');
const t0      = Date.now();
const json    = await whisper.transcribe(normalized, 0, Math.round(durationSec * 1000));
const elapsed = Date.now() - t0;

const result = JSON.parse(json);
console.log(`\n=== Transcript (${elapsed} ms) ===`);
console.log(result.text || '(empty)');
if (result.segments?.length) {
  console.log('\n=== Segments ===');
  for (const seg of result.segments) {
    console.log(`  [${seg.startMs}ms – ${seg.endMs}ms] ${seg.text}`);
  }
}

})();