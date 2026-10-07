import type { SwitchCloudEndpoint } from '@shared/core/switch-servers/switch-cloud';
import { type SwitchServer, urlOrigin } from '@shared/core/switch-servers/switch-servers';

/** Read at run time, so a dev run can be pointed at a deployment without a rebuild. */
const RUNTIME_VARIABLE = 'SWITCH_CLOUD_URL';
/** Inlined by electron-vite at build time, so a packaged build carries its own. */
const BUILD_VARIABLE = 'MAIN_VITE_SWITCH_CLOUD_URL';
const ENABLED_RUNTIME_VARIABLE = 'SWITCH_CLOUD_ENABLED';
const ENABLED_BUILD_VARIABLE = 'MAIN_VITE_SWITCH_CLOUD_ENABLED';

/**
 * Whether this run offers Switch Cloud at all. Off unless the run or the build
 * says exactly `true`, the run's value winning when it has one. Off hides every
 * Cloud surface; it is not the same as a build that names no Cloud URL yet. A
 * value other than `true` or `false` is a broken build or launch, and raised.
 */
export function switchCloudEnabled(): boolean {
  const fromRun = process.env[ENABLED_RUNTIME_VARIABLE]?.trim();
  if (fromRun) return parseEnabled(fromRun, ENABLED_RUNTIME_VARIABLE);
  const fromBuild = import.meta.env.MAIN_VITE_SWITCH_CLOUD_ENABLED?.trim();
  if (fromBuild) return parseEnabled(fromBuild, ENABLED_BUILD_VARIABLE);
  return false;
}

export function requireSwitchCloudEnabled(): void {
  if (!switchCloudEnabled()) {
    throw new Error(
      `Switch Cloud is turned off in this build. Set ${ENABLED_RUNTIME_VARIABLE}=true to turn it on.`
    );
  }
}

function parseEnabled(value: string, variable: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${variable} must be "true" or "false": ${value}`);
}

/**
 * Where Switch Cloud is, or null when Switch Cloud is turned off or neither
 * this run nor this build names it.
 *
 * Supplied from outside rather than written here, because this repository is
 * public and which deployment a build treats as the Cloud is a choice made per
 * build, not part of the source. Unset is a real answer — the Cloud choice is
 * then not offered — but a value that is not an https URL is a broken
 * build or launch, and raised as one rather than treated as unset. The one
 * exception is plain http to this machine, so a server run from a checkout can
 * stand in for the Cloud while testing (`just local-cloud`).
 */
export function switchCloudEndpoint(): SwitchCloudEndpoint | null {
  if (!switchCloudEnabled()) return null;
  return configuredEndpoint();
}

function configuredEndpoint(): SwitchCloudEndpoint | null {
  const fromRun = process.env[RUNTIME_VARIABLE]?.trim();
  if (fromRun) return { url: parseCloudUrl(fromRun, RUNTIME_VARIABLE) };
  const fromBuild = import.meta.env.MAIN_VITE_SWITCH_CLOUD_URL?.trim();
  if (fromBuild) return { url: parseCloudUrl(fromBuild, BUILD_VARIABLE) };
  return null;
}

export function requireSwitchCloudEndpoint(): SwitchCloudEndpoint {
  requireSwitchCloudEnabled();
  const endpoint = switchCloudEndpoint();
  if (!endpoint) {
    throw new Error(
      `Switch Cloud is not configured for this build. Set ${RUNTIME_VARIABLE} to its https URL.`
    );
  }
  return endpoint;
}

/**
 * Whether the server is Switch Cloud while this run has Switch Cloud turned
 * off. Such a server is kept but not listed. It is known only by the Cloud URL
 * the run or build names, so with none named nothing is hidden.
 */
export function isHiddenSwitchCloudServer(server: Pick<SwitchServer, 'gatewayUrl'>): boolean {
  if (switchCloudEnabled()) return false;
  const endpoint = configuredEndpoint();
  return endpoint !== null && urlOrigin(server.gatewayUrl) === urlOrigin(endpoint.url);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The origin alone: the Console appends `/gateway` itself, so a path would double up. */
function parseCloudUrl(value: string, variable: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variable} is not a URL: ${value}`);
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new Error(`${variable} must be an https URL, or http to localhost: ${value}`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${variable} must be an origin with no path, like https://host: ${value}`);
  }
  return url.origin;
}
