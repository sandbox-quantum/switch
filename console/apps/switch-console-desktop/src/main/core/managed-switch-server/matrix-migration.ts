/**
 * The one-way door out of Matrix, and the copy that has to happen before it.
 *
 * Room history from before Switch moved to the Postgres message store lives
 * only on the homeserver. The release after {@link LAST_MATRIX_VERSION}
 * deletes the Matrix transport, the backfill command and Tuwunel, so once a
 * stack is on it there is no longer anything that can read that history — not
 * later, not with a flag, not by rolling back, because the rollback would hand
 * an old core a migrated schema.
 *
 * So the upgrade that crosses the line copies first, on the version that still
 * can, and does not cross if the copy fails. There is no opt-out: an install
 * that skips it loses everything said in it before the move, silently, during
 * an update the user clicked yes to.
 *
 * The copy is safe to repeat. Rooms already walked to their start are skipped,
 * so a stack that crosses the line having already been backfilled by hand pays
 * one no-op container.
 */
import { log } from '@main/lib/logger';
import { LAST_MATRIX_VERSION, RELEASE_REPO_OWNER } from '@shared/app-identity';
import { dockerRunOneOff } from './compose';
import { GHCR_REGISTRY } from './constants';
import { classifyVersionDrift } from './deployed-version';
import type { ServerHost } from './host/types';

/**
 * Where the other containers are, from inside the stack's network.
 *
 * The stack's `.env` carries the credentials but not these: they live in each
 * service's own definition in the compose file, and the whole point of running
 * this by image rather than by compose service is not to depend on the version
 * of that file the user happens to have. Compose service names, unchanged
 * across every version this runs against.
 */
const STACK_ADDRESSES = {
  DB_HOST: 'postgres',
  DB_PORT: '5432',
  MATRIX_SERVER: 'http://tuwunel:8008',
};

/**
 * Whether starting `pinned` against a stack running `deployed` moves it past
 * the last version that can read the homeserver.
 *
 * False when the deployed version is unknown or not comparable: this gates a
 * copy, and a copy that runs when it did not need to costs one container,
 * while one that is skipped on a guess costs the history. Unknown is therefore
 * *not* the safe side here — but it is also not something this can act on, so
 * the caller logs it and the boundary is enforced by the release sequence
 * instead.
 */
export function crossesMatrixBoundary(deployed: string, pinned: string): boolean {
  const deployedIsPast = classifyVersionDrift(LAST_MATRIX_VERSION, deployed);
  const pinnedIsPast = classifyVersionDrift(LAST_MATRIX_VERSION, pinned);
  if (deployedIsPast?.direction === 'unknown' || pinnedIsPast?.direction === 'unknown') {
    return false;
  }
  // `classifyVersionDrift(a, b)` reads as "going from a to b": an upgrade means
  // b is newer. So the pinned version is past the boundary when moving from the
  // boundary to it is an upgrade, and the deployed one is at or below it when
  // that same move is not.
  const pinnedIsAfter = pinnedIsPast?.direction === 'upgrade';
  const deployedIsAfter = deployedIsPast?.direction === 'upgrade';
  return pinnedIsAfter && !deployedIsAfter;
}

export type BackfillOutcome = { ok: true } | { ok: false; detail: string };

/**
 * Copy the homeserver's history into Postgres, against the stack as it is
 * currently running.
 *
 * The image is pinned to {@link LAST_MATRIX_VERSION} rather than taken from
 * the stack, and that is the point: the install that most needs this is the one
 * that skipped that release, so its own images and its own compose file have no
 * backfill in them at all. Pinning the image means the copy does not depend on
 * which version the user happens to be coming from.
 *
 * Nothing here runs the compose service's entrypoint, which is written to let a
 * stack start anyway when the copy fails. Here that failure is the whole point:
 * it has to stop the upgrade.
 */
export async function runBackfill(
  host: ServerHost,
  onLog: (line: string) => void
): Promise<BackfillOutcome> {
  log.info(`managed-switch-server: backfilling room history before the upgrade (${host.label})`);
  try {
    await dockerRunOneOff(
      host,
      {
        image: `${GHCR_REGISTRY}/${RELEASE_REPO_OWNER}/switch-core:${LAST_MATRIX_VERSION}`,
        command: ['python', '-m', 'switch_core.cli.backfill', '--allow-empty'],
        env: STACK_ADDRESSES,
      },
      onLog
    );
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error(`managed-switch-server: backfill failed; not upgrading (${host.label})`, { detail });
    return { ok: false, detail };
  }
}
