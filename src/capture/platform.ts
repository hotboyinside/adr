// platform.ts
// Returns the platform-appropriate AudioCapture implementation.
// The real native addons (built in Slices 03a/03b) replace the MockSidecarManager
// used in Issue 02 for UI development.

import type { AudioCapture } from "./AudioCapture";

export function createAudioCapture(): AudioCapture {
  switch (process.platform) {
    case "darwin": {
      const { MacOSAudioCapture } =
        require("./MacOSAudioCapture") as typeof import("./MacOSAudioCapture");
      return new MacOSAudioCapture();
    }
    case "win32": {
      const { WindowsAudioCapture } =
        require("./WindowsAudioCapture") as typeof import("./WindowsAudioCapture");
      return new WindowsAudioCapture();
    }
    default:
      throw new Error(
        `Audio capture not yet implemented for platform: ${process.platform}. ` +
          `Linux (PulseAudio/PipeWire) is tracked in Issue 11.`,
      );
  }
}
