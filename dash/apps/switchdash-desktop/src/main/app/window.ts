import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import appIcon from '@/assets/images/switchdash/switchdash_logo.png?asset';
import { log } from '@main/lib/logger';
import { registerExternalLinkHandlers } from '@main/utils/externalLinks';
import { PRODUCT_NAME } from '@shared/app-identity';
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
      // __dirname resolves to out/main/ at runtime; preload is at out/preload/index.mjs
      preload: join(__dirname, '../preload/index.mjs'),
      // Enables the embedded room view's <webview> (CHOO-1674). Guests are
      // constrained in the will-attach-webview handler below, which is what
      // actually keeps this from widening the app's attack surface.
      webviewTag: true,
    },
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 10, y: 10 },
          acceptFirstMouse: true,
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

  constrainEmbeddedWebviews(mainWindow);

  // Show when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('focus', () => {
    if (typeof mainWindow?.setWindowButtonVisibility === 'function') {
      mainWindow.setWindowButtonVisibility(true);
    }
  });

  // Cleanup reference on close
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

/**
 * Strip privileges from any `<webview>` the renderer attaches.
 *
 * `webviewTag: true` lets renderer markup ask for a guest with whatever
 * webPreferences it likes, so the renderer is no longer the only thing that has
 * to be trusted — the embedded page is too. Rather than trusting the tag's
 * attributes, we overwrite the dangerous ones here, and allow only the guest
 * preload the app ships. Anything else is dropped.
 */
function constrainEmbeddedWebviews(window: BrowserWindow): void {
  const guestPreload = join(__dirname, '../preload/mattermost-guest.mjs');

  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    // Never honour a preload named in markup — pin it to the one we ship.
    webPreferences.preload = guestPreload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;

    // Only ever embed real web content. A file:// or custom-scheme guest would
    // be running local content with a preload attached, which is not something
    // this feature needs.
    const protocol = params.src ? new URL(params.src).protocol : null;
    if (protocol !== 'http:' && protocol !== 'https:') {
      log.warn('Blocked webview attach for non-http source', { src: params.src });
      event.preventDefault();
    }
  });
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
