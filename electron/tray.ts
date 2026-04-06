import { Tray, Menu, nativeImage, App, BrowserWindow } from 'electron';
import type { SidecarManager } from '../src/sidecar/SidecarManager';

let tray: Tray | null = null;

export function setupTray(
  app: App,
  mainWindow: BrowserWindow | null,
  sidecar: SidecarManager,
): { updateCaptureState(isCapturing: boolean): void } {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Verbatim');

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
      { label: 'Quit', click: () => app.quit() },
    ]);

  tray.setContextMenu(buildMenu(false));

  tray.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  function updateCaptureState(isCapturing: boolean): void {
    tray?.setToolTip(isCapturing ? 'Verbatim — Capturing audio' : 'Verbatim');
    tray?.setContextMenu(buildMenu(isCapturing));
    // Set Dock badge on macOS
    if (process.platform === 'darwin') {
      app.dock?.setBadge(isCapturing ? '●' : '');
    }
  }

  return { updateCaptureState };
}
