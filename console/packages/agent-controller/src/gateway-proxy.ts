/**
 * The provider gateway's own way out of a box: a proxy URL carrying the
 * gateway's proxy user, in `SWITCH_CONTROLLER_GATEWAY_PROXY`.
 *
 * On a box whose egress proxy opens the provider hosts only to that user, the
 * password is what keeps agents from calling providers directly. So it must
 * never reach a child process. Everything this controller starts inherits its
 * environment (agent hosts, provider version checks, the sign-in check, the
 * probe), and the generic `HTTPS_PROXY` is passed on to the provider CLIs on
 * purpose. So the gateway's proxy has a variable of its own, taken out of the
 * environment the moment the controller starts and held only here, in memory,
 * for the gateway's transport.
 *
 * - The value is never logged, returned in a report, or named in an error:
 *   messages name the variable only.
 * - With it set, a generic proxy variable carrying credentials is refused at
 *   start, since every agent would inherit it. Without it, nothing changes:
 *   a desktop behind an authenticating proxy keeps working.
 * - Split boxes only. Deleting a variable doesn't change the process's
 *   starting environment (`/proc/<pid>/environ`), so the password stays
 *   readable there for the controller's life. Only a split box keeps that out
 *   of the agents' reach (their own process namespace); without the split,
 *   agents run as the controller's user and could read it.
 */
import { ConfigurationError } from './errors';

export const GATEWAY_PROXY_ENV = 'SWITCH_CONTROLLER_GATEWAY_PROXY';

/** The proxy variables children inherit: none may carry credentials beside the gateway's. */
const INHERITED_PROXY_ENV = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const;

let held: string | null = null;

/** Whether a proxy setting carries a user or password (`http://user:pass@host`). */
export function carriesCredentials(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    return url.username !== '' || url.password !== '';
  } catch {
    // Unparsable: an `@` before the first path slash still means credentials.
    const authority = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0] ?? '';
    return authority.includes('@');
  }
}

/**
 * Takes the gateway's proxy out of `env` and holds it. Called first thing at
 * start, and again after an env file is merged into the environment. The
 * variable is removed before anything is checked, so even a refused value
 * never stays where a child could inherit it. Absent, it leaves the one
 * already held alone.
 */
export function takeGatewayProxy(env: NodeJS.ProcessEnv): void {
  const raw = env[GATEWAY_PROXY_ENV];
  delete env[GATEWAY_PROXY_ENV];
  if (raw === undefined) return;
  const value = raw.trim();
  if (!value) {
    held = null;
    return;
  }
  let url: URL;
  try {
    url = new URL(value.includes('://') ? value : `http://${value}`);
  } catch {
    held = null;
    throw new ConfigurationError(`${GATEWAY_PROXY_ENV} is not a URL.`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') {
    held = null;
    throw new ConfigurationError(`${GATEWAY_PROXY_ENV} must be an http:// or https:// URL.`);
  }
  for (const name of INHERITED_PROXY_ENV) {
    const other = env[name];
    if (other !== undefined && carriesCredentials(other)) {
      held = null;
      throw new ConfigurationError(
        `${name} carries proxy credentials, which everything this controller starts would inherit. ` +
          `Give the gateway its proxy in ${GATEWAY_PROXY_ENV} only.`
      );
    }
  }
  held = value;
}

/** Why the gateway's proxy can't be used on this box, or null when it can: split boxes only. */
export function gatewayProxyProblem(split: boolean): string | null {
  if (held === null || split) return null;
  return (
    `${GATEWAY_PROXY_ENV} is for split boxes only (--launcher-address or --launcher-socket): without the split, agents run as ` +
    "this controller's user and could read it from the controller's starting environment."
  );
}

/** The gateway's proxy, or null when none was given. For the gateway's transport only. */
export function heldGatewayProxy(): string | null {
  return held;
}

/** Only for tests: forget the held proxy. */
export function forgetGatewayProxy(): void {
  held = null;
}
