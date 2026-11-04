import { shell, type BrowserWindow, type WebContents } from 'electron';
import { DEEPLINK_SCHEME, handleDeeplinkUrl } from '@main/app/deeplinks';
import { APP_ORIGIN } from '@main/app/protocol';
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

/**
 * Schemes no window of the app ever opens a window on nor moves to: a page
 * made from bytes in the renderer (a chat attachment's object URL, say) or a
 * local file would run with that window's privileges, the main window's
 * preload bridge included.
 */
const LOCAL_CONTENT = /^(blob|data|javascript|filesystem|file):/i;

function schemeOf(url: string): string {
  const colon = url.indexOf(':');
  return colon > 0 ? url.slice(0, colon + 1).toLowerCase() : '?';
}

/**
 * The floor for every web contents the app creates (`web-contents-created`):
 * no window on, and no move to, local content (`LOCAL_CONTENT`), whatever else
 * that window allows. The main window and room-view guests then set their own,
 * stricter handling; a window that sets none (a sign-in window, say) keeps
 * Electron's default for everything else.
 */
export function guardLocalContent(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (!LOCAL_CONTENT.test(url)) return { action: 'allow' };
    log.warn('Blocked a window on local content', { scheme: schemeOf(url) });
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!LOCAL_CONTENT.test(url)) return;
    event.preventDefault();
    log.warn('Blocked a move to local content', { scheme: schemeOf(url) });
  });
}

/**
 * The main window's link handling: it opens and moves only within the app
 * itself; our own `switchdash://` deeplinks are handled in-process, as for a
 * room-view guest; an external http(s) link goes to the person's browser
 * (after they confirm); and anything else (blob:, data:, javascript:, file:,
 * any other scheme) is refused.
 */
export function registerExternalLinkHandlers(win: BrowserWindow, isDev: boolean) {
  const wc = win.webContents;

  const isInternalAppUrl = (url: string) => {
    if (isDev) return url.startsWith(process.env.ELECTRON_RENDERER_URL!);
    // Packaged, only the app's own origin: a localhost page is a web page like
    // any other (to the browser), never a window with the preload.
    return url === APP_ORIGIN || url.startsWith(`${APP_ORIGIN}/`);
  };
  const isExternalWeb = (url: string) => /^https?:\/\//i.test(url);
  const isDeeplink = (url: string) => url.startsWith(`${DEEPLINK_SCHEME}://`);

  // Handle window.open and target="_blank"
  wc.setWindowOpenHandler(({ url }) => {
    if (isInternalAppUrl(url)) return { action: 'allow' };
    if (isDeeplink(url)) handleDeeplinkUrl(url);
    else if (isExternalWeb(url)) requestExternalLinkOpen(url);
    else log.warn('Blocked a window on a non-web URL', { scheme: schemeOf(url) });
    return { action: 'deny' };
  });

  // Intercept navigations that would leave the app
  wc.on('will-navigate', (event, url) => {
    if (isInternalAppUrl(url)) return;
    event.preventDefault();
    if (isDeeplink(url)) handleDeeplinkUrl(url);
    else if (isExternalWeb(url)) requestExternalLinkOpen(url);
    else log.warn('Blocked moving the app window to a non-web URL', { scheme: schemeOf(url) });
  });
}
