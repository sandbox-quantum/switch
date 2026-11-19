import { appService } from '@main/core/app/service';
import { log } from '@main/lib/logger';
import { dashboardOrigin, type SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { GatewayError, mintBrowserHandoff } from './gateway-client';
import { assertServesDashboard } from './server-address';
import { getSessionCookie } from './servers-store';

/** What a server older than the browser sign-in answers for it: no route,
 * or a route there for another method. */
const PREDATES_HANDOFF = new Set([404, 405]);

/**
 * Open one of a server's dashboard pages in the person's default browser,
 * signed in as Console's account when Console is signed in there.
 *
 * Console's own session never leaves Console. It asks the server for a
 * one-time sign-in link (`mintBrowserHandoff`), good for a minute, and the
 * browser redeems it for a session of its own; the code rides in the link's
 * fragment, which the browser never sends. Where Console has no session, or
 * the server predates the link, the page opens as it is, and the dashboard
 * asks the person to sign in.
 *
 * A managed server is always asked: the authenticated call signs Console in
 * again when it holds no session there, and selects the workspace a lease on
 * the server is asserting (`gateway-client`'s `silentLogin`). Signing in here
 * directly would mint the link from a session bound to no workspace.
 *
 * `url` must be on the server's dashboard origin, so a link is only ever
 * opened there. Never log the link: its fragment holds the code.
 */
export async function openDashboardPage(server: SwitchServer, url: string): Promise<void> {
  const origin = new URL(dashboardOrigin(server)).origin;
  const page = new URL(url);
  if (page.origin !== origin) {
    throw new Error(`Refusing to open ${url}: not on the dashboard origin ${origin}`);
  }
  if (!server.managed) await assertServesDashboard(server);
  const path = await signedInPath(server, `${page.pathname}${page.search}${page.hash}`);
  await appService.openExternal(path === null ? url : signedInUrl(origin, path));
}

/** The path of a link that signs a browser in and opens `next`, or null
 * when the page is to open signed out. */
async function signedInPath(server: SwitchServer, next: string): Promise<string | null> {
  if (!server.managed && !(await getSessionCookie(server.id))) {
    log.info('switch-servers: opening a dashboard page signed out; Console has no session', {
      server: server.id,
    });
    return null;
  }
  try {
    return (await mintBrowserHandoff(server, next)).path;
  } catch (cause) {
    if (!(cause instanceof GatewayError)) throw cause;
    if (cause.kind === 'unauthorized') {
      log.warn(
        'switch-servers: opening a dashboard page signed out; the server took no session from Console',
        { server: server.id, status: cause.status }
      );
      return null;
    }
    if (cause.kind === 'http' && cause.status !== undefined && PREDATES_HANDOFF.has(cause.status)) {
      log.warn(
        'switch-servers: opening a dashboard page signed out; the server predates browser sign-in',
        { server: server.id, status: cause.status }
      );
      return null;
    }
    throw cause;
  }
}

/** `path` on the dashboard's origin, refused unless it stays there. */
function signedInUrl(origin: string, path: string): string {
  const url = `${origin}${path}`;
  if (!path.startsWith('/') || new URL(url).origin !== origin) {
    throw new Error('The server answered with a sign-in link that leaves its dashboard');
  }
  return url;
}
