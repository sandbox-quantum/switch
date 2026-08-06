import { log } from '@main/lib/logger';
import { compareVersions } from '@main/lib/semver';
import type {
  SwitchVersionDrift,
  SwitchVersionDriftDirection,
} from '@shared/core/managed-switch-server/managed-switch-server';
import { runningImages } from './compose';
import { ENV_FILE_NAME } from './constants';
import type { ServerHost } from './host/types';

/**
 * What switch-core version a managed stack is actually deployed at.
 *
 * The `COMPATIBLE_SWITCH_VERSION` pin only says what THIS build of switchdash
 * wants; it is written into the `.env` at every start. Answering
 * "did the app's pin move underneath a stack that is already up?" needs the
 * other side of the comparison, read back off the host.
 */

/** The core service whose image tag defines the stack's version. */
const CORE_SERVICE = 'switch';

export type DeployedVersion =
  /** Read successfully. `source` records how, since the two differ in strength:
   * `container` is what is running right now; `env-file` is what the last start
   * asked for, which is the only signal available while the stack is stopped. */
  | { kind: 'deployed'; version: string; source: 'container' | 'env-file' }
  /** Nothing has ever been deployed here — no running core container and no
   * `.env`. A first start, not a drift. */
  | { kind: 'absent' }
  /** Neither source could be read. Distinct from `absent` on purpose: an
   * unreachable daemon must not be mistaken for an empty host. */
  | { kind: 'unreadable'; reason: string };

/**
 * Read the switch-core version deployed on `host`.
 *
 * Prefers the running core container's image tag — the only ground truth for
 * what is executing — and falls back to `SWITCH_VERSION` in the on-host `.env`,
 * which still matters when the stack is stopped: the data volumes survive, so a
 * stopped stack's last deployed version is what the database has migrated to.
 */
export async function readDeployedVersion(host: ServerHost): Promise<DeployedVersion> {
  const failures: string[] = [];

  try {
    const image = (await runningImages(host)).get(CORE_SERVICE);
    const tag = image ? imageTag(image) : null;
    if (tag) return { kind: 'deployed', version: tag, source: 'container' };
  } catch (error) {
    failures.push(`container image: ${errorText(error)}`);
  }

  try {
    const env = await host.readFile(ENV_FILE_NAME);
    if (env === null) {
      // No `.env` and no running container: nothing was ever deployed here.
      if (failures.length === 0) return { kind: 'absent' };
    } else {
      const version = envVersion(env);
      if (version) return { kind: 'deployed', version, source: 'env-file' };
      failures.push(`${ENV_FILE_NAME}: no SWITCH_VERSION entry`);
    }
  } catch (error) {
    failures.push(`${ENV_FILE_NAME}: ${errorText(error)}`);
  }

  if (failures.length === 0) return { kind: 'absent' };
  return { kind: 'unreadable', reason: failures.join('; ') };
}

/**
 * Compare a deployed version against this build's pin.
 *
 * Returns null when they match — the common case, and the only one that needs
 * no user-facing surface.
 */
export function classifyVersionDrift(
  deployed: string,
  expected: string
): SwitchVersionDrift | null {
  if (deployed === expected) return null;
  const order = compareVersions(deployed, expected);
  if (order === 0) return null;
  const direction: SwitchVersionDriftDirection =
    order === null ? 'unknown' : order < 0 ? 'upgrade' : 'downgrade';
  return { deployed, expected, direction };
}

/**
 * The `deployedVersion` / `drift` half of a managed server's status, read off
 * `host`. Shared by the local and remote supervisors so both surface the same
 * thing at boot.
 *
 * A host we cannot read reports no drift: the caller is a status reconcile, and
 * inventing a drift banner out of a failed probe would be worse than staying
 * quiet. The start path guards separately (see `startStack`), so an unreadable
 * host here cannot let a downgrade through.
 */
export async function readVersionStatus(
  host: ServerHost,
  expected: string
): Promise<{ deployedVersion: string | null; drift: SwitchVersionDrift | null }> {
  const deployed = await readDeployedVersion(host);
  if (deployed.kind === 'unreadable') {
    log.warn(
      `managed-switch-server: could not read the deployed switch-core version on ${host.label}`,
      { reason: deployed.reason }
    );
    return { deployedVersion: null, drift: null };
  }
  if (deployed.kind === 'absent') return { deployedVersion: null, drift: null };
  return {
    deployedVersion: deployed.version,
    drift: classifyVersionDrift(deployed.version, expected),
  };
}

/** The tag of a `[registry[:port]/]repo[:tag]` image reference, or null when it
 * carries no tag (an implicit `latest`, or a `@sha256:` digest pin — neither
 * names a version we can compare). */
function imageTag(image: string): string | null {
  const lastSlash = image.lastIndexOf('/');
  const name = lastSlash === -1 ? image : image.slice(lastSlash + 1);
  if (name.includes('@')) return null;
  const colon = name.lastIndexOf(':');
  if (colon === -1) return null;
  const tag = name.slice(colon + 1).trim();
  return tag.length > 0 ? tag : null;
}

/** `SWITCH_VERSION` from a generated `.env`, unquoted, or null when absent. */
function envVersion(env: string): string | null {
  for (const raw of env.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('SWITCH_VERSION=')) continue;
    const value = line
      .slice('SWITCH_VERSION='.length)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (value.length > 0) return value;
  }
  return null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
