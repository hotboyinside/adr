// AudioCapture interface — defined in Issue 02, stable per ADR-001.
// Do not change without a new ADR.

export interface AudioCaptureOptions {
  sampleRate: 16000 | 44100 | 48000;
  channels: 1 | 2;
  bitDepth: 16 | 32;
}

export interface AudioChunk {
  pcm: Buffer;        // raw PCM samples
  capturedAt: number; // Unix timestamp ms
  sampleRate: number;
  channels: number;
  bitDepth: number;
}

export interface AudioCapture {
  start(options: AudioCaptureOptions): Promise<void>;
  stop(): Promise<void>;
  on(event: 'data', listener: (chunk: AudioChunk) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'stopped', listener: () => void): this;
}
