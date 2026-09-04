import { KV } from '@main/db/kv';
import { log } from '@main/lib/logger';
import { listPlugins } from '../providers/plugin-registry';
import { switchSetupService } from './switch-setup-service';

/**
 * Bring every installed Switch connector up to the version this build ships,
 * once.
 *
 * Deliberately not a standing auto-updater. The Update button in
 * Settings → Agents stays the normal path; this exists because a connector's
 * pinned `@sandboxaq/switch-agent-runtime` version only moves when a user goes
 * looking for it, and a user who never does keeps whatever they first
 * installed — indefinitely, across every release. One catch-up closes that gap
 * without turning every launch into a plugin update.
 *
 * Generation rather than a boolean, following the agent-storage migration: a
 * latched install short-circuits, and a deliberate bump here — not a release,
 * not a version change elsewhere — is what makes it run again.
 */
const CATCH_UP_GENERATION = 1;

/**
 * A broken environment must not turn a one-shot into a per-launch job. Failures
 * are usually transient (offline, a marketplace mid-push), so retry — but stop,
 * because "runs every boot forever" is the thing this is not.
 */
const MAX_ATTEMPTS = 3;

type CatchUpMarker = { generation: number; attempts: number };

const store = new KV<{ state: CatchUpMarker }>('switchSetupCatchUp');

/** What one connector's catch-up did, for deciding whether to latch. */
type Step = 'nothing-to-do' | 'updated' | 'failed';

async function catchUpOne(agentId: string): Promise<Step> {
  // Refreshes the marketplace for a CLI connector; for a file-based one it is
  // the same local read as getStatus, since that connector ships in the app.
  const status = await switchSetupService.checkForUpdates(agentId);

  // Not installed is not a gap to close. Installing a connector the user never
  // asked for is a decision that is theirs, and this is a version catch-up.
  if (!status.installed) return 'nothing-to-do';

  if (status.refreshError !== null) {
    // The catalog could not be read, so `updateAvailable` means "no update was
    // visible", not "no update exists". Latching on that would spend the one
    // shot on an answer we did not get.
    log.warn('catchUpConnectors: could not refresh the catalog; will retry', {
      event: 'connector_catch_up_deferred',
      agentId,
      reason: status.refreshError,
    });
    return 'failed';
  }

  if (!status.updateAvailable) return 'nothing-to-do';

  const result = await switchSetupService.update(agentId);
  if (!result.success) {
    log.warn('catchUpConnectors: update failed', {
      event: 'connector_catch_up_failed',
      agentId,
      from: status.installedVersion,
      to: status.latestVersion,
      reason: result.message,
    });
    return 'failed';
  }

  log.info('catchUpConnectors: connector updated', {
    event: 'connector_catch_up_updated',
    agentId,
    from: status.installedVersion,
    to: status.latestVersion,
  });
  return 'updated';
}

/**
 * Run the catch-up if this install has not completed it.
 *
 * Best-effort and unawaited by its caller: it talks to a plugin marketplace
 * over the network and must never hold up a launch or fail one.
 */
export async function catchUpConnectorsToCurrentVersion(): Promise<void> {
  const marker = (await store.get('state')) ?? { generation: 0, attempts: 0 };
  if (marker.generation >= CATCH_UP_GENERATION) return;
  if (marker.attempts >= MAX_ATTEMPTS) return;

  const agentIds = listPlugins()
    .filter((plugin) => plugin.capabilities.switchSetup.kind !== 'none')
    .map((plugin) => plugin.metadata.id);

  let updated = 0;
  let failed = 0;

  for (const agentId of agentIds) {
    try {
      const step = await catchUpOne(agentId);
      if (step === 'updated') updated += 1;
      if (step === 'failed') failed += 1;
    } catch (error) {
      // One agent type's CLI being absent or broken says nothing about the
      // others, so carry on and let the attempt count decide when to stop.
      failed += 1;
      log.warn('catchUpConnectors: connector threw during catch-up', {
        event: 'connector_catch_up_failed',
        agentId,
        error: String(error),
      });
    }
  }

  if (failed > 0) {
    await store.set('state', { generation: marker.generation, attempts: marker.attempts + 1 });
    return;
  }

  await store.set('state', { generation: CATCH_UP_GENERATION, attempts: marker.attempts });
  if (updated > 0) {
    log.info('catchUpConnectors: connectors brought up to date', {
      event: 'connector_catch_up_complete',
      updated,
    });
  }
}
