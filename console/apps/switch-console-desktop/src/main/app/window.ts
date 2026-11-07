import { join } from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import appIcon from '@/assets/images/switch-console/icon-dock.png?asset';
import { events } from '@main/lib/events';
import { registerExternalLinkHandlers } from '@main/utils/externalLinks';
import { PRODUCT_NAME } from '@shared/app-identity';
import { appCommandNavigateChannel } from '@shared/events/appEvents';
import { APP_ORIGIN } from './protocol';

let mainWindow: BrowserWindow | null = null;

export function createMainWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 700,
    minHeight: 500,
    title: PRODUCT_NAME,
    // In production, electron-builder injects the icon from the app bundle.
    ...(import.meta.env.DEV && { icon: appIcon }),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Required for ESM preload scripts (.mjs)
      sandbox: false,
      // import.meta.dirname resolves to out/main/ at runtime; preload is at out/preload/index.mjs
      preload: join(import.meta.dirname, '../preload/index.mjs'),
    },
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 10, y: 10 },
          acceptFirstMouse: true,
          // The sidebar is meant to read as a vibrancy material rather than a
          // painted panel, which means the desktop behind the window has to
          // show through it. Only the compositor can blur what is behind a
          // window — CSS `backdrop-filter` reaches no further than the page —
          // so the effect is the OS's and the renderer only tints it.
          //
          // A transparent `backgroundColor` is what stops Electron painting an
          // opaque sheet over the effect. The renderer must not repaint one
          // either: `index.html` keys its translucent material on the same
          // platform test this branch does.
          vibrancy: 'under-window',
          visualEffectState: 'active',
          backgroundColor: '#00000000',
        }
      : {}),
    show: false,
  });

  if (import.meta.env.DEV) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL!);
  } else {
    void mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  }

  // Route external links to the user’s default browser
  registerExternalLinkHandlers(mainWindow, import.meta.env.DEV);

  // Show when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Windows delivers the mouse's back/forward buttons here rather than to the
  // page, so they have to be handed across; macOS and Linux give them to the
  // renderer as ordinary mouse events and never reach this.
  mainWindow.on('app-command', (_event, command) => {
    if (command === 'browser-backward') {
      events.emit(appCommandNavigateChannel, { direction: 'back' });
    } else if (command === 'browser-forward') {
      events.emit(appCommandNavigateChannel, { direction: 'forward' });
    }
  });

  mainWindow.on('focus', () => {
    if (typeof mainWindow?.setWindowButtonVisibility === 'function') {
      mainWindow.setWindowButtonVisibility(true);
    }
  });

  // The renderer refuses an unload while a screen has unsaved changes; the
  // person decides here, since a page cannot show its own dialog during unload.
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'question',
      message: 'You have unsaved changes',
      detail: 'If you leave now, your unsaved changes will be lost.',
      buttons: ['Stay', 'Discard and leave'],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice === 1) event.preventDefault();
  });

  // Cleanup reference on close
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * Brings Console to the front, over whatever app is there (a browser that
 * just finished a sign-in, say), and returns the window it showed, or null
 * before the window exists.
 */
export function focusMainWindow(): BrowserWindow | null {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return null;
  if (win.isMinimized()) win.restore();
  win.show();
  if (process.platform === 'darwin') {
    app.focus({ steal: true });
  } else {
    app.focus();
  }
  win.focus();
  return win;
}
