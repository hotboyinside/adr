#!/usr/bin/env ts-node
// scripts/test-capture-macos.ts
// Smoke test: capture 5 seconds of system audio and write raw PCM to output.pcm
//
// Prerequisites:
//   1. npm run build:native  (builds MacOSAudioCapture.node)
//   2. Grant Screen Recording permission when prompted
//
// Verify output:
//   ffplay -f f32le -ar 48000 -ac 2 output.pcm

import * as fs from 'fs';
import * as path from 'path';
import { MacOSAudioCapture } from '../src/capture/MacOSAudioCapture';
import type { AudioChunk } from '../src/capture/AudioCapture';

const CAPTURE_DURATION_MS = 5000;
const OUTPUT_FILE = path.join(__dirname, '..', 'output.pcm');

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.error('This script is macOS-only.');
    process.exit(1);
  }

  const capture = new MacOSAudioCapture();
  const writeStream = fs.createWriteStream(OUTPUT_FILE);

  let chunkCount = 0;
  let totalBytes = 0;

  capture.on('data', (chunk: AudioChunk) => {
    writeStream.write(chunk.pcm);
    chunkCount++;
    totalBytes += chunk.pcm.length;
    if (chunkCount % 10 === 0) {
      process.stdout.write(`\r  chunks: ${chunkCount}  bytes: ${(totalBytes / 1024).toFixed(1)} KB`);
    }
  });

  capture.on('error', (err: Error & { code?: string }) => {
    console.error(`\nCapture error [${err.code ?? 'UNKNOWN'}]: ${err.message}`);
    if (err.code === 'PERMISSION_DENIED') {
      console.error('\nGrant Screen Recording access in:');
      console.error('  System Settings → Privacy & Security → Screen Recording');
    }
    process.exit(1);
  });

  console.log(`Starting ${CAPTURE_DURATION_MS / 1000}s capture...`);

  await capture.start({ sampleRate: 48000, channels: 2, bitDepth: 32 });
  console.log('Capture started. Play some audio now.\n');

  await new Promise<void>(resolve => setTimeout(resolve, CAPTURE_DURATION_MS));

  await capture.stop();
  writeStream.end();

  console.log(`\n\nDone. Captured ${chunkCount} chunks (${(totalBytes / 1024).toFixed(1)} KB)`);
  console.log(`Output: ${OUTPUT_FILE}`);
  console.log('\nPlayback:');
  console.log('  ffplay -f f32le -ar 48000 -ac 2 output.pcm');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
