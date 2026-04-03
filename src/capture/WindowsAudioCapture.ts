// WindowsAudioCapture.ts
// TypeScript wrapper around the WASAPI loopback N-API addon.
// Only loads on win32 — throws on other platforms.

import { EventEmitter } from 'events';
import path from 'path';
import type { AudioCapture, AudioCaptureOptions, AudioChunk } from './AudioCapture';

type NativeChunk = {
  pcm: Buffer;
  capturedAt: number;
  sampleRate: number;
  channels: number;
  bitDepth: number;
};

type NativeErrorPayload = {
  code: string;
  message: string;
};

export class WindowsAudioCapture extends EventEmitter implements AudioCapture {
  private native: {
    start(sampleRate: number, channels: number, bitDepth: number): Promise<void>;
    stop(): Promise<void>;
  };

  constructor() {
    super();

    if (process.platform !== 'win32') {
      throw new Error('WindowsAudioCapture is only available on Windows');
    }

    const addonPath = path.join(
      __dirname,
      '../../sidecar/build/Release/WindowsAudioCapture.node'
    );

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nativeModule = require(addonPath);

    this.native = new nativeModule.WindowsAudioCapture(
      // onData
      (chunk: NativeChunk) => {
        this.emit('data', chunk satisfies AudioChunk);
      },
      // onError
      (payload: NativeErrorPayload) => {
        const err = Object.assign(new Error(payload.message), { code: payload.code });
        this.emit('error', err);
      },
      // onStopped
      () => {
        this.emit('stopped');
      }
    );
  }

  async start(options: AudioCaptureOptions): Promise<void> {
    return this.native.start(options.sampleRate, options.channels, options.bitDepth);
  }

  async stop(): Promise<void> {
    return this.native.stop();
  }
}
