import { contextBridge, ipcRenderer } from 'electron';
import type { SidecarMessage } from '../src/sidecar/SidecarManager';

contextBridge.exposeInMainWorld('transcribeAPI', {
  startCapture: (): Promise<void> => ipcRenderer.invoke('capture:start'),
  stopCapture: (): Promise<void> => ipcRenderer.invoke('capture:stop'),
  onTranscript: (callback: (msg: SidecarMessage) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, msg: SidecarMessage) => callback(msg);
    ipcRenderer.on('sidecar:message', handler);
    // Return cleanup function
    return () => ipcRenderer.removeListener('sidecar:message', handler);
  },
});
