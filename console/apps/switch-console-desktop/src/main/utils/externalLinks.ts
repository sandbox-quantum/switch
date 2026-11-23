import { shell, type BrowserWindow, type WebContents } from 'electron';
import { DEEPLINK_SCHEME, handleDeeplinkUrl } from '@main/app/deeplinks';
import { isAppRendererUrl } from '@main/app/protocol';
import { getMainWindow } from '@main/app/window';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { externalLinkOpenRequestedChannel } from '@shared/events/appEvents';
import { isHttpUrl, isWebContentUrl } from './external-url-policy';

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

type FrameNavigation = { url: string; preventDefault: () => void };

/**
 * Stop a frame navigating anywhere but web content. A frame pointed at a
 * custom scheme hands the URL to whichever app the OS registered for it, with
 * no click and no question asked.
 */
function refuseNonWebNavigation(navigation: FrameNavigation, source: string): void {
  if (isWebContentUrl(navigation.url)) return;
  navigation.preventDefault();
  log.warn('Blocked a navigation with an unsupported scheme', { source, url: navigation.url });
}

/**
 * Link handling for a window showing a server's own pages: the in-app sign-in.
 *
 * The pages are the server's, and through it an identity provider's, so they
 * get no say over windows or schemes. They open no windows of their own — a
 * sign-in page could otherwise float a frameless, always-on-top one over every
 * app — and an http(s) link they would have opened goes to the browser through
 * the same confirmation as every other link. Navigation is limited by scheme
 * rather than origin, because a sign-in legitimately crosses to the identity
 * provider's origin and back.
 */
export function registerServerPageLinkHandlers(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) requestExternalLinkOpen(url);
    else log.warn('Blocked a window with an unsupported scheme from a server page', { url });
    return { action: 'deny' };
  });
  contents.on('will-frame-navigate', (navigation) => refuseNonWebNavigation(navigation, 'server'));
  contents.on('will-redirect', (navigation) => refuseNonWebNavigation(navigation, 'server'));
}

/**
 * Link handling for the app's own window. It never opens a window: a link to
 * a Console page or a session moves the app there, an http(s) link goes to the
 * browser through the confirmation, and anything else is dropped. A
 * navigation to a custom scheme is left to the permission policy
 * (`app/web-security.ts`), the one place an OS launch is decided.
 */
export function registerExternalLinkHandlers(win: BrowserWindow) {
  const wc = win.webContents;

  const route = (url: string): void => {
    if (url.startsWith(`${DEEPLINK_SCHEME}://`)) {
      handleDeeplinkUrl(url);
      return;
    }
    if (isHttpUrl(url) && !isAppRendererUrl(url)) {
      requestExternalLinkOpen(url);
      return;
    }
    log.warn('Blocked a link with an unsupported scheme from the app window', { url });
  };

  // Handle window.open and target="_blank"
  wc.setWindowOpenHandler(({ url }) => {
    route(url);
    return { action: 'deny' };
  });

  // Intercept navigations that would leave the app
  wc.on('will-navigate', (event, url) => {
    if (isAppRendererUrl(url)) return;
    if (url.startsWith(`${DEEPLINK_SCHEME}://`) || isHttpUrl(url)) {
      event.preventDefault();
      route(url);
    }
  });
}
