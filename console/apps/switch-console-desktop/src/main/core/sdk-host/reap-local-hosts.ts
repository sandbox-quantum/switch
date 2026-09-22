import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getRemoteAgentLocation } from '@main/core/agents/agent-location';
import { getAgents } from '@main/core/agents/getAgents';
import { log } from '@main/lib/logger';
import { localStateBase, savedAgentId, writeWatchFlags } from './local-host';
import { ownedElsewhere } from './local-host-owners';

const STOP_ATTEMPTS = 100;
const STOP_INTERVAL_MS = 200;

/**
 * Asks a detached watcher to stop by clearing its enabled flag, which is the
 * same signal the SSH path uses. Its worker is watching the file and returns,
 * its supervisor sees a clean exit, and both release their owner records.
 */
async function stopDetachedWatcher(root: string): Promise<void> {
  if (!(await ownedElsewhere(root))) return;
  log.warn('Stopping a detached watcher that an earlier build left running for a local agent', {
    root,
  });
  await writeWatchFlags(root, { enabled: false, spawn: false });
  for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt++) {
    if (!(await ownedElsewhere(root))) return;
    await delay(STOP_INTERVAL_MS);
  }
  throw new Error(
    `A detached watcher under ${root} did not stop. Stop it by hand before local automatic sessions can run.`
  );
}

/**
 * Earlier builds of this branch deployed a detached watcher for local agents
 * too, so a machine that ran one is still hosting a process Console no longer
 * manages. Stop those before starting the in-process watchers that replace
 * them; a root whose agent cannot be identified is left alone rather than
 * guessed at.
 */
export async function reapDetachedLocalWatchers(): Promise<void> {
  // A local host requires a POSIX execution machine, so Windows can have no
  // local watcher root to reap and no `ps` to identify one with.
  if (process.platform === 'win32') return;
  const base = localStateBase('sdk-watchers');
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const agents = await getAgents();
  for (const entry of entries) {
    const root = join(base, entry);
    try {
      const switchAgentId = savedAgentId(root);
      if (!switchAgentId) continue;
      const agent = agents.find((candidate) => candidate.switchAgentId === switchAgentId);
      if (!agent) continue;
      if (await getRemoteAgentLocation(agent)) continue;
      await stopDetachedWatcher(root);
    } catch (error) {
      log.error('Could not stop a detached watcher left by an earlier build', {
        root,
        error: String(error),
      });
    }
  }
}
