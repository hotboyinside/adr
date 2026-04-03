import { Tray, Menu, nativeImage, App, BrowserWindow } from 'electron';
import path from 'path';
import type { SidecarManager } from '../src/sidecar/SidecarManager';

let tray: Tray | null = null;

export function setupTray(
  app: App,
  mainWindow: BrowserWindow | null,
  sidecar: SidecarManager
): void {
  // Use a blank 16x16 image as placeholder — replace with real icon asset
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Transcribe');

  const buildMenu = (isCapturing: boolean) =>
    Menu.buildFromTemplate([
      {
        label: isCapturing ? 'Stop Capture' : 'Start Capture',
        click: async () => {
          if (isCapturing) {
            await sidecar.stop();
          } else {
            await sidecar.start();
          }
          tray?.setContextMenu(buildMenu(!isCapturing));
        },
      },
      { type: 'separator' },
      {
        label: 'Show Window',
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => app.quit(),
      },
    ]);

  tray.setContextMenu(buildMenu(false));

  tray.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}
