import { app, BrowserWindow, ipcMain, nativeImage } from 'electron';
import path from 'path';
import { setupTray } from './tray';
import { MockSidecarManager } from '../src/sidecar/SidecarManager';
import type { SidecarManager, SidecarMessage } from '../src/sidecar/SidecarManager';
import { NativeSidecarManager } from '../src/sidecar/NativeSidecarManager';
import { NoOpAIModule } from '../src/ai/AIModule';
import type { SessionState } from '../src/session/SessionState';
import { DEFAULT_SESSION_STATE } from '../src/session/SessionState';

let mainWindow: BrowserWindow | null = null;

function createSidecar(): SidecarManager {
  try {
    return new NativeSidecarManager();
  } catch {
    console.warn('Native sidecar unavailable, falling back to mock');
    return new MockSidecarManager();
  }
}

const sidecar = createSidecar();
const aiModule = new NoOpAIModule();
let sessionState: SessionState = { ...DEFAULT_SESSION_STATE };

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    title: 'Transcribe',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Wire sidecar messages to renderer
sidecar.on('message', (msg: SidecarMessage) => {
  if (msg.type === 'status') {
    sessionState = { ...sessionState, status: msg.value };
  }

  if (msg.type === 'error') {
    console.error(`[sidecar error] ${msg.code}: ${msg.message}`);
  }

  if (msg.type === 'final' || msg.type === 'partial') {
    aiModule.onTranscript({ type: msg.type, text: msg.text, startMs: msg.startMs, endMs: msg.endMs });
  }

  mainWindow?.webContents.send('sidecar:message', msg);
});

sidecar.on('exit', (code: number) => {
  console.log(`Sidecar exited with code ${code}`);
  sessionState = { ...sessionState, status: 'idle' };
  mainWindow?.webContents.send('sidecar:message', { type: 'status', value: 'idle' });
});

// IPC handlers
ipcMain.handle('capture:start', async () => {
  aiModule.onSessionStart(sessionState.context);
  await sidecar.start();
});

ipcMain.handle('capture:stop', async () => {
  await sidecar.stop();
  aiModule.onSessionEnd();
});

ipcMain.handle('session:getState', () => sessionState);

app.whenReady().then(() => {
  createWindow();
  setupTray(app, mainWindow, sidecar);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  await sidecar.stop();
  aiModule.onSessionEnd();
});
