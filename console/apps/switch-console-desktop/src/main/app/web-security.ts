import { app, session, type Session, type WebContents } from 'electron';
import { log } from '@main/lib/logger';
import { isAllowedExternalUrl } from '@main/utils/external-url-policy';
import { isAppRendererUrl } from './protocol';
import { getMainWindow } from './window';

/**
 * The browser permissions any page in Console is given.
 *
 * Most of what Console shows is someone else's page — a server's sign-in and
 * dashboard, the room view's Mattermost — and Electron grants a page whatever
 * it asks for unless told otherwise: the camera and microphone, location,
 * notifications in Console's name, reading the clipboard. Nothing Console
 * shows needs those. What is granted: writing the clipboard (every copy
 * button), going full screen, and letting an embedded page use the cookies it
 * already has, which a sign-in page embedding its provider may ask for.
 */
const GRANTED_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-sanitized-write',
  'fullscreen',
  'storage-access',
  'top-level-storage-access',
]);

export type PermissionAsk = {
  permission: string;
  /** Asked by the main frame of the app's own window, showing the app. */
  fromAppWindow: boolean;
  /** For `openExternal`, the address a page asked the OS to open. */
  externalUrl: string | undefined;
};

/**
 * Whether a page gets a browser permission.
 *
 * `openExternal` is Chromium handing a custom-scheme URL to whichever app the
 * OS registered for it, which a page can set off with an iframe or a redirect
 * and no click. Only the app's own window may, and only for the schemes
 * `appService.openExternal` opens; links anywhere else are routed by the link
 * handlers in `externalLinks.ts`, which send http(s) through a confirmation.
 */
export function isPermissionGranted(ask: PermissionAsk): boolean {
  if (ask.permission === 'openExternal') {
    return (
      ask.fromAppWindow && ask.externalUrl !== undefined && isAllowedExternalUrl(ask.externalUrl)
    );
  }
  return GRANTED_PERMISSIONS.has(ask.permission);
}

function isAppWindowFrame(
  contents: WebContents | null,
  isMainFrame: boolean,
  requestingUrl: string | undefined
): boolean {
  const main = getMainWindow();
  return (
    contents !== null &&
    main !== null &&
    !main.isDestroyed() &&
    contents === main.webContents &&
    isMainFrame &&
    requestingUrl !== undefined &&
    isAppRendererUrl(requestingUrl)
  );
}

function applyPermissionPolicy(ses: Session): void {
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const externalUrl = 'externalURL' in details ? details.externalURL : undefined;
    const granted = isPermissionGranted({
      permission,
      fromAppWindow: isAppWindowFrame(contents, details.isMainFrame, details.requestingUrl),
      externalUrl,
    });
    if (!granted) {
      log.warn('Refused a browser permission a page asked for', {
        permission,
        requestingUrl: details.requestingUrl,
        externalUrl,
      });
    }
    callback(granted);
  });
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    isPermissionGranted({
      permission,
      fromAppWindow: isAppWindowFrame(
        contents,
        details.isMainFrame,
        details.requestingUrl ?? requestingOrigin
      ),
      externalUrl: undefined,
    })
  );
}

/**
 * Put the permission policy on every session: the default one the app window
 * uses, and each partition made later (sign-in, gateway, room view). Called
 * before the app is ready, so it is in place before any window opens.
 */
export function registerWebSecurity(): void {
  app.on('session-created', applyPermissionPolicy);
  void app.whenReady().then(() => applyPermissionPolicy(session.defaultSession));
}
