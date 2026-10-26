import type { SwitchClient } from '../clients/switch-client.ts';
import type { ServerSurface } from '../gate/gate.ts';

/**
 * A check derived from the surface snapshot rather than written per route:
 * every gateway route that takes a signed-in session answers 401 to a request
 * that carries none, and answers it as the API rather than with the gateway
 * SPA's HTML page. A deployment that serves the SPA and the API from one host
 * falls back to the page for any path it does not route, so an API route that
 * went missing would otherwise look like a page that loaded.
 *
 * It covers nothing in the coverage gate's sense — a 401 says nothing about
 * what the route does — but it is free for every route the server adds, and
 * catches a session check that a refactor dropped, which the snapshot would
 * only show as a route moving to `none` in a diff.
 *
 * A route behind a feature flag the deployment has off is not mounted, and
 * answers 404 for that reason alone, so the probe skips exactly those: the
 * snapshot names each route's flags, and the deployment says which it has on.
 * A WebSocket route (`WS /gateway/...`) is probed with its opening handshake,
 * which a session socket refuses with the same 401.
 * Every other session route is probed, whether or not it appears in the
 * deployment's OpenAPI document. Path parameters get a well-formed id that names nothing: the
 * session check runs before the route ever looks the id up.
 */

const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';

export function probePath(route: string): { method: string; path: string } {
  const [method, template] = route.split(' ', 2) as [string, string];
  return { method, path: template.replace(/\{[^}]+\}/g, PLACEHOLDER_ID) };
}

export interface SessionProbe {
  probed: number;
  /** Session routes behind a feature flag this deployment has off. */
  notMounted: number;
  /** Each probed route that did not answer 401, or answered with HTML, with what it answered. */
  wrong: string[];
}

/** Whether a response is a web page rather than an API answer. */
export function isHtml(contentType: string): boolean {
  return contentType.toLowerCase().includes('text/html');
}

export async function probeSessionRoutes(
  switchClient: SwitchClient,
  surface: ServerSurface
): Promise<SessionProbe> {
  const enabled = await switchClient.enabledFeatureFlags();
  const result: SessionProbe = { probed: 0, notMounted: 0, wrong: [] };
  for (const { route, auth, flags } of surface.gatewayRoutes) {
    if (auth !== 'session') continue;
    if (!flags.every((flag) => enabled.has(flag))) {
      result.notMounted += 1;
      continue;
    }
    const { method, path } = probePath(route);
    const { status, contentType } = await switchClient.statusWithoutCredentials(method, path);
    result.probed += 1;
    if (status !== 401 || isHtml(contentType)) {
      result.wrong.push(`${route} -> ${status} ${contentType || '(no content type)'}`);
    }
  }
  return result;
}
