import * as os from 'node:os';
import * as path from 'node:path';
import { reapOrphanedRuntimes as sweep } from '@sandboxaq/switch-agent-runtime';
import { log } from '@main/lib/logger';

/**
 * Terminate `switch-agent-runtime` processes whose host is gone, at boot.
 *
 * The runtime does this for itself now, and also exits on its own when its host
 * dies — but both fixes reach a machine only through the connector pin, which
 * moves when a user updates a marketplace plugin. This path reaches them when
 * they update the app instead. The two populations are not the same: someone
 * who never revisits Settings → Agents is reached only from here, and someone
 * running Codex standalone is reached only by the runtime. Neither alone is
 * enough, which is why both exist.
 *
 * The predicate is imported rather than reimplemented. Two copies of "is this
 * runtime abandoned?" is the shape of bug this repo already knows well — where
 * they disagree, one of them kills a live session — so the one implementation
 * lives in the runtime package and both callers share it.
 *
 * Everything found here is dead weight by construction: a runtime with no live
 * host has nobody to serve, and the session it belonged to is already gone.
 */
export async function reapOrphanedAgentRuntimes(): Promise<void> {
  const sessionsRoot = path.join(os.homedir(), '.switch', 'sessions');

  // Nothing to spare: the app is not itself a runtime and owns no session
  // directory. Its own pid is protected inside the sweep regardless.
  const outcome = await sweep({ sessionsRoot, keepSessionDir: null });

  if (outcome.reaped > 0 || outcome.removedSessionDirs > 0) {
    log.info('reapOrphanedAgentRuntimes: cleared runtimes left by earlier sessions', {
      event: 'agent_runtime_reap',
      reaped: outcome.reaped,
      removedSessionDirs: outcome.removedSessionDirs,
    });
  }

  for (const failure of outcome.failures) {
    log.warn('reapOrphanedAgentRuntimes: sweep step failed', {
      event: 'agent_runtime_reap_failed',
      stage: failure.stage,
      error: String(failure.error),
    });
  }
}
