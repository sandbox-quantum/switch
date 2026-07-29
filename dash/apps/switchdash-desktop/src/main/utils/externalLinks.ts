import { shell, type BrowserWindow, type WebContents } from 'electron';
import { getMainWindow } from '@main/app/window';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { externalLinkOpenRequestedChannel } from '@shared/events/appEvents';

/**
 * Ensure any external HTTP(S) links open in the user's default browser
 * rather than inside the Electron window. Keeps app navigation scoped
 * to our renderer while preserving expected link behavior.
 */
function requestExternalLinkOpen(url: string) {
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    events.emit(externalLinkOpenRequestedChannel, { url });
    return;
  }

  log.warn('External link request had no main window; opening directly', { url });
  shell.openExternal(url).catch((error: unknown) => {
    log.warn('Failed to open external link without main window', { url, error });
  });
}

/**
 * Link handling for an embedded `<webview>` guest (the room view's Mattermost).
 *
 * A guest gets none of the main window's handlers, and Electron's default for
 * an unhandled `window.open` is to deny it — so every external link in a
 * message silently did nothing when clicked. Mattermost renders those as
 * `target="_blank"`, which is `window.open`.
 *
 * "Internal" here means the guest's own origin, not the app's: a link back into
 * Mattermost should move the pane, and anything else belongs in the browser.
 */
export function registerGuestLinkHandlers(guest: WebContents) {
  const guestOrigin = (): string | null => {
    try {
      return new URL(guest.getURL()).origin;
    } catch {
      return null;
    }
  };

  const isSameOrigin = (url: string): boolean => {
    const origin = guestOrigin();
    return origin !== null && (url === origin || url.startsWith(`${origin}/`));
  };

  guest.setWindowOpenHandler(({ url }) => {
    if (!/^https?:\/\//i.test(url)) {
      log.warn('Blocked non-http window.open from embedded room view', { url });
      return { action: 'deny' };
    }
    // Never let the guest spawn a window: it would be chrome-less, unmanaged
    // and outside the room pane. Same-origin goes to the pane itself instead.
    if (isSameOrigin(url)) {
      void guest.loadURL(url);
    } else {
      requestExternalLinkOpen(url);
    }
    return { action: 'deny' };
  });

  guest.on('will-navigate', (event, url) => {
    if (isSameOrigin(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) requestExternalLinkOpen(url);
    else log.warn('Blocked non-http navigation from embedded room view', { url });
  });
}

export function registerExternalLinkHandlers(win: BrowserWindow, isDev: boolean) {
  const wc = win.webContents;

  const isInternalAppUrl = (url: string) => {
    if (isDev) return url.startsWith(process.env.ELECTRON_RENDERER_URL!);
    return url.startsWith('file://') || /^http:\/\/(127\.0\.0\.1|localhost):\d+(?:\/|$)/i.test(url);
  };

  // Handle window.open and target="_blank"
  wc.setWindowOpenHandler(({ url }) => {
    if (!isInternalAppUrl(url) && /^https?:\/\//i.test(url)) {
      requestExternalLinkOpen(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Intercept navigations that would leave the app
  wc.on('will-navigate', (event, url) => {
    if (!isInternalAppUrl(url) && /^https?:\/\//i.test(url)) {
      event.preventDefault();
      requestExternalLinkOpen(url);
    }
  });
}
