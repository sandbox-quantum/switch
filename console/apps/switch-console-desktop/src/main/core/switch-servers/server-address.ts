import { getDomain } from 'tldts';
import { log } from '@main/lib/logger';
import {
  dashboardOrigin,
  type SwitchServer,
  urlOrigin,
} from '@shared/core/switch-servers/switch-servers';
import { clearDashboardUrl, listServers } from './servers-store';

const PROBE_TIMEOUT_MS = 5000;

/**
 * The address given for a server answered as a web page rather than as the
 * Switch API. On an older server the dashboard has an address of its own, and
 * it answers every path with its page, so it is the address people most often
 * paste by mistake.
 */
export class NotTheServerAddressError extends Error {
  constructor(url: string) {
    super(
      `${url} answered with a web page, not the Switch server. That is usually the address of ` +
        `an older server's dashboard. Enter the server's own address instead: the one its agents ` +
        `connect to, often the same host on port 8000.`
    );
    this.name = 'NotTheServerAddressError';
  }
}

function isHtml(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html');
}

/**
 * Refuse an address that is positively the wrong one: one whose health check
 * comes back as a page, successfully. Every switch-core answers `/health` with
 * JSON, and a dashboard served on an address of its own answers every path
 * with its page. A proxy's own error page (a 404 or a 502 in HTML) is not that,
 * and is left alone with everything else.
 *
 * Anything else is let through, unreachable included, because the sign-in that
 * follows adding a server reports those failures in its own words; refusing
 * here as well would turn "the server is down" into "the address is wrong".
 */
export async function assertServerAddress(url: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${url.replace(/\/+$/, '')}/health`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    log.warn('switch-servers: could not check the server address before saving it', {
      url,
      error: String(error),
    });
    return;
  }
  if (response.ok && isHtml(response)) throw new NotTheServerAddressError(url);
}

/**
 * Whether `origin` serves the dashboard: answers its root with a page. Null
 * when it could not be asked at all.
 */
export async function servesDashboard(origin: string): Promise<boolean | null> {
  try {
    const response = await fetch(`${origin.replace(/\/+$/, '')}/`, {
      headers: { Accept: 'text/html' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.ok && isHtml(response);
  } catch {
    return null;
  }
}

/**
 * A server's own address does not answer the management API under `/gateway`:
 * something other than switch-core answered there with a web page. Console
 * reaches every server's management API at its own address, the one its agents
 * use, so a proxy in front of that address that routes only the agent API
 * leaves Console nothing to talk to.
 */
export class NoManagementApiError extends Error {
  constructor(serverName: string, url: string, status: number) {
    super(
      `${serverName} does not answer at ${url}/gateway: a web page came back (HTTP ${status}) ` +
        `where switch-core answers the management API. Switch Console reaches a server's ` +
        `management API at the server's own address. Ask whoever runs it to route /gateway on ` +
        `${url} to switch-core, as the agent API already is.`
    );
    this.name = 'NoManagementApiError';
  }
}

/** A server's dashboard pages cannot be opened, because nothing serves them. */
export class NoDashboardError extends Error {
  constructor(serverName: string, origin: string) {
    super(
      `${serverName} does not serve its dashboard at ${origin}. The server is older than ` +
        `switch-core serving the dashboard on its own address; once whoever runs it upgrades ` +
        `it, its pages open from here.`
    );
    this.name = 'NoDashboardError';
  }
}

/**
 * Refuse to open a dashboard page where there is no dashboard, rather than
 * handing the browser the API's refusal to read. The case is a server added
 * by its own address while it still kept its dashboard elsewhere: Console has
 * no other address for it. An address that cannot be asked at all is left to
 * the browser to report.
 */
export async function assertServesDashboard(server: SwitchServer): Promise<void> {
  const origin = dashboardOrigin(server);
  if ((await servesDashboard(origin)) === false) throw new NoDashboardError(server.name, origin);
}

/** The domain a hostname is registered under, by the public-suffix list with
 * its private section: `example.com` for `switch-api.example.com`, but
 * `acme.ngrok.app` for itself, since anyone can take a name beside it. Null for
 * an IP address, `localhost` or a single-label name. */
function registrableDomain(hostname: string): string | null {
  return getDomain(hostname, { allowPrivateDomains: true });
}

/** Whether two addresses are on one host, or on hosts of one registered domain:
 * `switch-gateway.example.com` beside `switch-api.example.com`, but not
 * `evil.ngrok.app` beside `acme.ngrok.app`, nor `evil.co.uk` beside
 * `acme.co.uk`. */
function onTheSameDomain(a: string, b: string): boolean {
  const [hostA, hostB] = [new URL(a).hostname, new URL(b).hostname];
  if (hostA === hostB) return true;
  const domain = registrableDomain(hostA);
  return domain !== null && domain === registrableDomain(hostB);
}

/**
 * The address to keep as a server's separate dashboard: `candidate`, when it
 * is on the server's own domain, serves the dashboard, and the server's own
 * address does not; otherwise null.
 *
 * An invite link to an older server names its dashboard's host, which is the
 * one place Console learns that address without asking anyone for it. A link
 * is anyone's to write, though, and the address kept is where browser sign-in
 * starts, so a host on another domain is not taken on its word.
 */
export async function separateDashboard(url: string, candidate: string): Promise<string | null> {
  if (urlOrigin(candidate) === urlOrigin(url)) return null;
  if (!onTheSameDomain(url, candidate)) {
    log.warn('switch-servers: not keeping an invite link’s host as the dashboard address', {
      url,
      candidate,
      reason: 'not on the server’s own domain',
    });
    return null;
  }
  const [own, other] = await Promise.all([servesDashboard(url), servesDashboard(candidate)]);
  return own !== true && other === true ? candidate : null;
}

/**
 * Drop a server's separate dashboard address once it has stopped being needed:
 * the server's own address serves the dashboard, and the separate one no
 * longer does.
 *
 * Both, not just the first. An operator who upgrades switch-core but keeps the
 * old dashboard host may still have its identity provider returning there, and
 * browser sign-in starts on the dashboard's address, so moving off a host that
 * still works could break sign-in for nothing. Once that host has gone,
 * nothing can depend on it any longer.
 *
 * Managed servers are left alone: each start registers the addresses its
 * stack publishes, so a value cleared here would only come back.
 */
export async function retireDashboardFallback(server: SwitchServer): Promise<boolean> {
  if (server.managed || server.dashboardUrl === null) return false;
  const [own, separate] = await Promise.all([
    servesDashboard(server.url),
    servesDashboard(server.dashboardUrl),
  ]);
  // An old address that cannot be reached counts as gone, on purpose. A host
  // whose DNS record was removed answers nothing forever, so waiting for a
  // definite "no dashboard here" would keep it for good. And dropping one that
  // was only briefly down costs nothing: `own` serving the dashboard means the
  // server also sends a sign-in started on its own address on to the host its
  // identity provider returns to, as Console's sign-in window does.
  if (own !== true || separate === true) return false;
  await clearDashboardUrl(server.id, server.url);
  log.info('switch-servers: the server now serves its own dashboard; dropped the old address', {
    server: server.id,
    url: server.url,
    dashboardUrl: server.dashboardUrl,
    oldAddressAnswered: separate !== null,
  });
  return true;
}

/** {@link retireDashboardFallback} for every registered server, one at a time
 * failing on its own. */
export async function retireDashboardFallbacks(): Promise<void> {
  const servers = await listServers();
  const results = await Promise.allSettled(servers.map(retireDashboardFallback));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      log.warn('switch-servers: could not check whether a server still needs its old dashboard', {
        server: servers[index]?.id,
        error: String(result.reason),
      });
    }
  });
}
