import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { setupTray } from './tray';
import { MockSidecarManager } from '../src/sidecar/SidecarManager';
import type { SidecarManager, SidecarMessage } from '../src/sidecar/SidecarManager';
import { NativeSidecarManager } from '../src/sidecar/NativeSidecarManager';
import { NoOpAIModule } from '../src/ai/AIModule';
import type { SessionContext } from '../src/ai/AIModule';
import { SessionOrchestrator } from '../src/session/SessionOrchestrator';
import { WebSocketOutputServer } from '../src/ipc/WebSocketOutputServer';
import type { SessionState } from '../src/session/SessionState';
import { DEFAULT_SESSION_STATE } from '../src/session/SessionState';
import { checkScreenRecordingPermission, openSystemSettings } from '../src/permissions/MacOSPermissions';
import { readSettings, writeSettings } from '../src/permissions/settings';

let mainWindow: BrowserWindow | null = null;
let trayControls: { updateCaptureState(b: boolean): void } | null = null;

// ── Sidecar / orchestrator ────────────────────────────────────────────────────

function createSidecar(): SidecarManager {
  try {
    return new NativeSidecarManager();
  } catch {
    console.warn('Native sidecar unavailable, falling back to mock');
    return new MockSidecarManager();
  }
}

const wsServer     = new WebSocketOutputServer();
const sidecar      = createSidecar();
const aiModule     = new NoOpAIModule();
const orchestrator = new SessionOrchestrator(
  sidecar,
  aiModule,
  (questions) => mainWindow?.webContents.send('ai:questions', questions),
  wsServer,
);

let sessionState: SessionState = { ...DEFAULT_SESSION_STATE };

// ── DEVICE_LOST auto-retry ────────────────────────────────────────────────────

let deviceLostRetryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleDeviceLostRetry(context: SessionContext): void {
  if (deviceLostRetryTimer) return;
  deviceLostRetryTimer = setTimeout(async () => {
    deviceLostRetryTimer = null;
    try {
      await orchestrator.startSession(context);
    } catch {
      // If retry also fails, the next error event will handle it
    }
  }, 3_000);
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    title: 'Verbatim',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Sidecar event wiring ──────────────────────────────────────────────────────

sidecar.on('message', (msg: SidecarMessage) => {
  if (msg.type === 'status') {
    sessionState = { ...sessionState, status: msg.value };
    trayControls?.updateCaptureState(msg.value === 'capturing');
  }

  if (msg.type === 'error') {
    console.error(`[sidecar error] ${msg.code}: ${msg.message}`);
    if (msg.code === 'DEVICE_LOST' && sessionState.status === 'capturing') {
      scheduleDeviceLostRetry(sessionState.context);
    }
  }

  mainWindow?.webContents.send('sidecar:message', msg);
});

sidecar.on('exit', (code: number) => {
  console.log(`Sidecar exited with code ${code}`);
  sessionState = { ...sessionState, status: 'idle' };
  trayControls?.updateCaptureState(false);
  mainWindow?.webContents.send('sidecar:message', { type: 'status', value: 'idle' });
});

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('permissions:getState', () => {
  const { hasShownConsent } = readSettings();
  const permissionState = checkScreenRecordingPermission();
  return { hasShownConsent, permissionState };
});

ipcMain.handle('permissions:acknowledge', () => {
  writeSettings({ hasShownConsent: true });
  const permissionState = checkScreenRecordingPermission();
  return { hasShownConsent: true, permissionState };
});

ipcMain.handle('permissions:check', () => {
  return { permissionState: checkScreenRecordingPermission() };
});

ipcMain.handle('permissions:openSettings', async () => {
  await openSystemSettings();
});

ipcMain.handle('session:start', async (_event, role: SessionContext['role']) => {
  // Guard: check permission before every session start
  const permissionState = checkScreenRecordingPermission();
  if (permissionState === 'denied') {
    throw new Error('PERMISSION_DENIED');
  }

  if (deviceLostRetryTimer) {
    clearTimeout(deviceLostRetryTimer);
    deviceLostRetryTimer = null;
  }

  const context: SessionContext = { role };
  sessionState = { ...sessionState, context };
  await orchestrator.startSession(context);
});

ipcMain.handle('session:stop', async () => {
  if (deviceLostRetryTimer) {
    clearTimeout(deviceLostRetryTimer);
    deviceLostRetryTimer = null;
  }
  await orchestrator.stopSession();
});

ipcMain.handle('session:getState', () => sessionState);

ipcMain.handle('ws:getPort', () => wsServer.port);

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await wsServer.start();
  createWindow();
  trayControls = setupTray(app, mainWindow, sidecar);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  if (deviceLostRetryTimer) clearTimeout(deviceLostRetryTimer);
  await orchestrator.stopSession();
  wsServer.stop();
});
