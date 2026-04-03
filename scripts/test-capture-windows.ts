#!/usr/bin/env ts-node
// scripts/test-capture-windows.ts
// Smoke test: capture 5 seconds of system audio via WASAPI and write raw PCM to output.pcm
//
// Prerequisites:
//   1. npm run build:native  (builds WindowsAudioCapture.node)
//   2. No application must hold the audio device in exclusive mode
//
// Verify output (format depends on GetMixFormat — typically f32le 44100/48000 Hz stereo):
//   ffplay -f f32le -ar 48000 -ac 2 output.pcm

import * as fs from 'fs';
import * as path from 'path';
import { WindowsAudioCapture } from '../src/capture/WindowsAudioCapture';
import type { AudioChunk } from '../src/capture/AudioCapture';

const CAPTURE_DURATION_MS = 5000;
const OUTPUT_FILE = path.join(__dirname, '..', 'output.pcm');

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    console.error('This script is Windows-only.');
    process.exit(1);
  }

  const capture = new WindowsAudioCapture();
  const writeStream = fs.createWriteStream(OUTPUT_FILE);

  let chunkCount = 0;
  let totalBytes = 0;
  let detectedSampleRate = 48000;
  let detectedChannels = 2;
  let detectedBitDepth = 32;

  capture.on('data', (chunk: AudioChunk) => {
    writeStream.write(chunk.pcm);
    chunkCount++;
    totalBytes += chunk.pcm.length;
    detectedSampleRate = chunk.sampleRate;
    detectedChannels   = chunk.channels;
    detectedBitDepth   = chunk.bitDepth;
    if (chunkCount % 10 === 0) {
      process.stdout.write(`\r  chunks: ${chunkCount}  bytes: ${(totalBytes / 1024).toFixed(1)} KB`);
    }
  });

  capture.on('error', (err: Error & { code?: string }) => {
    console.error(`\nCapture error [${err.code ?? 'UNKNOWN'}]: ${err.message}`);
    if (err.code === 'EXCLUSIVE_MODE') {
      console.error('\nClose any application with exclusive audio control (e.g. some DAWs, games).');
    }
    if (err.code === 'DEVICE_LOST') {
      console.error('\nAudio device was disconnected. Reconnect and retry.');
    }
    process.exit(1);
  });

  console.log(`Starting ${CAPTURE_DURATION_MS / 1000}s capture...`);

  await capture.start({ sampleRate: 48000, channels: 2, bitDepth: 32 });
  console.log('Capture started. Play some audio now.\n');

  await new Promise<void>(resolve => setTimeout(resolve, CAPTURE_DURATION_MS));

  await capture.stop();
  writeStream.end();

  const fmt = detectedBitDepth === 32 ? 'f32le' : 's16le';
  console.log(`\n\nDone. Captured ${chunkCount} chunks (${(totalBytes / 1024).toFixed(1)} KB)`);
  console.log(`Detected format: ${detectedSampleRate} Hz, ${detectedChannels}ch, ${detectedBitDepth}-bit`);
  console.log(`Output: ${OUTPUT_FILE}`);
  console.log('\nPlayback:');
  console.log(`  ffplay -f ${fmt} -ar ${detectedSampleRate} -ac ${detectedChannels} output.pcm`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
