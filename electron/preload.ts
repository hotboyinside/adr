import { contextBridge, ipcRenderer } from 'electron';
import type { SidecarMessage } from '../src/sidecar/SidecarManager';
import type { GeneratedQuestion, SessionContext } from '../src/ai/AIModule';
import type { MacOSPermissionState } from '../src/permissions/MacOSPermissions';

export interface PermissionState {
  hasShownConsent: boolean;
  permissionState: MacOSPermissionState;
}

contextBridge.exposeInMainWorld('transcribeAPI', {
  // ── Session ─────────────────────────────────────────────────────────────
  startSession: (role: SessionContext['role']): Promise<void> =>
    ipcRenderer.invoke('session:start', role),

  stopSession: (): Promise<void> =>
    ipcRenderer.invoke('session:stop'),

  // ── Permissions ──────────────────────────────────────────────────────────
  getPermissionState: (): Promise<PermissionState> =>
    ipcRenderer.invoke('permissions:getState'),

  acknowledgeConsent: (): Promise<PermissionState> =>
    ipcRenderer.invoke('permissions:acknowledge'),

  checkPermission: (): Promise<{ permissionState: MacOSPermissionState }> =>
    ipcRenderer.invoke('permissions:check'),

  openSystemSettings: (): Promise<void> =>
    ipcRenderer.invoke('permissions:openSettings'),

  // ── Events ───────────────────────────────────────────────────────────────
  onTranscript: (callback: (msg: SidecarMessage) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, msg: SidecarMessage) => callback(msg);
    ipcRenderer.on('sidecar:message', handler);
    return () => ipcRenderer.removeListener('sidecar:message', handler);
  },

  onQuestions: (callback: (questions: GeneratedQuestion[]) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, questions: GeneratedQuestion[]) =>
      callback(questions);
    ipcRenderer.on('ai:questions', handler);
    return () => ipcRenderer.removeListener('ai:questions', handler);
  },

  getWsPort: (): Promise<number> => ipcRenderer.invoke('ws:getPort'),
});
