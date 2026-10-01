import type { SwitchCloudEndpoint } from '@shared/core/switch-servers/switch-cloud';

/** Read at run time, so a dev run can be pointed at a deployment without a rebuild. */
const RUNTIME_VARIABLE = 'SWITCH_CLOUD_URL';
/** Inlined by electron-vite at build time, so a packaged build carries its own. */
const BUILD_VARIABLE = 'MAIN_VITE_SWITCH_CLOUD_URL';

/**
 * Where Switch Cloud is, or null when neither this run nor this build names it.
 *
 * Supplied from outside rather than written here, because this repository is
 * public and which deployment a build treats as the Cloud is a choice made per
 * build, not part of the source. Unset is a real answer — the Cloud choice then
 * says it is not open yet — but a value that is not an https URL is a broken
 * build or launch, and raised as one rather than treated as unset. The one
 * exception is plain http to this machine, so a server run from a checkout can
 * stand in for the Cloud while testing (`just local-cloud`).
 */
export function switchCloudEndpoint(): SwitchCloudEndpoint | null {
  const fromRun = process.env[RUNTIME_VARIABLE]?.trim();
  if (fromRun) return { url: parseCloudUrl(fromRun, RUNTIME_VARIABLE) };
  const fromBuild = import.meta.env.MAIN_VITE_SWITCH_CLOUD_URL?.trim();
  if (fromBuild) return { url: parseCloudUrl(fromBuild, BUILD_VARIABLE) };
  return null;
}

export function requireSwitchCloudEndpoint(): SwitchCloudEndpoint {
  const endpoint = switchCloudEndpoint();
  if (!endpoint) {
    throw new Error(
      `Switch Cloud is not configured for this build. Set ${RUNTIME_VARIABLE} to its https URL.`
    );
  }
  return endpoint;
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
