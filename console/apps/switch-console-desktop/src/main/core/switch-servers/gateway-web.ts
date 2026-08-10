import { BrowserWindow, session as electronSession } from 'electron';
import { log } from '@main/lib/logger';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { reauthenticateManagedServer } from './auth';
import { getSessionCookie } from './servers-store';

const SWITCH_AUTH_COOKIE = 'switch_auth';

/**
 * Open a gateway web page (the operator dashboard) in an in-app window that is
 * already signed in. The system browser can't be handed our httponly
 * `switch_auth` cookie, so we open an Electron window and inject the stored
 * cookie into its isolated session before loading — the reverse of what OIDC
 * login does when it reads the cookie back out. For the managed local server we
 * mint a session first (Switch Console holds its admin creds) so the page is always
 * authenticated; other servers open with whatever session is stored, falling
 * back to the gateway's own sign-in page if none.
 *
 * `url` must live on the server's gateway origin — the caller builds it from
 * `server.gatewayUrl` — so the injected cookie is only ever exposed to the
 * gateway itself.
 */
export async function openAuthenticatedGatewayPage(
  server: SwitchServer,
  url: string
): Promise<void> {
  const gatewayOrigin = new URL(server.gatewayUrl).origin;
  if (new URL(url).origin !== gatewayOrigin) {
    throw new Error(`Refusing to open ${url}: not on the gateway origin ${gatewayOrigin}`);
  }

  let jwt = await getSessionCookie(server.id);
  if (!jwt && server.managed) {
    jwt = await reauthenticateManagedServer(server);
  }

  // A persistent per-server partition isolates the gateway session from other
  // servers and from the app's own web content, and keeps it across opens.
  const partition = `persist:switch-gateway:${server.id}`;
  const ses = electronSession.fromPartition(partition);

  if (jwt) {
    try {
      await ses.cookies.set({
        url: gatewayOrigin,
        name: SWITCH_AUTH_COOKIE,
        value: jwt,
        httpOnly: true,
        sameSite: 'lax',
        secure: gatewayOrigin.startsWith('https'),
      });
    } catch (cause) {
      // Non-fatal: the page still opens, just unauthenticated (its own sign-in).
      log.warn('Could not inject Switch session cookie into gateway window', {
        server: server.id,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: server.name,
    autoHideMenuBar: true,
    webPreferences: { partition, nodeIntegration: false, contextIsolation: true },
  });
  await win.loadURL(url);
}
