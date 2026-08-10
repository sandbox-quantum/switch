import { shell, type BrowserWindow, type WebContents } from 'electron';
import { DEEPLINK_SCHEME, handleDeeplinkUrl } from '@main/app/deeplinks';
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
 * Three destinations, in order of specificity:
 *
 *  - our own `switchdash://` deeplinks, which agents post into rooms so a human
 *    can jump to the session behind a message. Handled in-process rather than
 *    handed to the OS: the app is already running and is the registered
 *    handler, so a round trip through the shell would at best come back to us.
 *  - the guest's own origin, which moves the pane rather than opening a window.
 *  - anything else http(s), which belongs in the user's browser.
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

  // Never let the guest spawn a window: it would be chrome-less, unmanaged and
  // outside the room pane. Every case below therefore denies, having routed the
  // URL somewhere useful first.
  const route = (url: string): void => {
    if (url.startsWith(`${DEEPLINK_SCHEME}://`)) {
      handleDeeplinkUrl(url);
      return;
    }
    if (isSameOrigin(url)) {
      void guest.loadURL(url);
      return;
    }
    if (/^https?:\/\//i.test(url)) {
      requestExternalLinkOpen(url);
      return;
    }
    log.warn('Blocked link with an unsupported scheme from the embedded room view', { url });
  };

  guest.setWindowOpenHandler(({ url }) => {
    route(url);
    return { action: 'deny' };
  });

  guest.on('will-navigate', (event, url) => {
    if (isSameOrigin(url)) return;
    event.preventDefault();
    route(url);
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
