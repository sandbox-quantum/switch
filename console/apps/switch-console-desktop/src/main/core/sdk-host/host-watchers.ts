import { z } from 'zod';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { READ_JSON } from './remote-json';
import { IS_STATE_ROOT } from './state-roots';

/**
 * What every watcher on one host is currently doing — one command, whatever
 * the agent count.
 *
 * Bringing a controller up costs about a dozen SSH round trips, and its usual
 * outcome is nothing at all: the watcher is already running the build we would
 * have installed, so the launcher looks at it and leaves it alone. Opening
 * Console on a host with twenty agents paid that cost twenty times to discover
 * twenty times that there was nothing to do — and paid it again on every host
 * reconnect, which on an unstable tunnel is constantly.
 *
 * This asks once instead. What it reports is exactly what the host-side
 * launcher decides on (`liveSupervisor` in `agent-providers/host/launch.ts`):
 * is a supervisor process alive, and which build does it say it is running.
 * It also returns the watch flags, since the bring-up writes those too and a
 * skip has to mean "nothing would have changed", not just "it is running".
 *
 * Deliberately only facts. It does not decide anything — see
 * `watcherIsCurrent` for that, so the decision lives in one place and can be
 * read without the script.
 */
export const WATCHER_STATUS_SCRIPT = String.raw`${READ_JSON}${IS_STATE_ROOT}
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const [baseArg] = process.argv.slice(1);
const base = baseArg || path.join(os.homedir(), '.local', 'state', 'switch', 'sdk-watchers');
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
let names = [];
try { names = fs.readdirSync(base).filter(isStateRoot); } catch {}
const found = [];
for (const name of names) {
  const root = path.join(base, name);
  let config;
  try { config = readJson(path.join(root, 'config.json')); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
  if (!config || !config.session || !config.session.agentId) continue;
  let owner = null;
  try { owner = readJson(path.join(root, 'supervisor', 'owner.json')); } catch (e) { if (e.code !== 'ENOENT') throw e }
  let watch = null;
  try { watch = readJson(path.join(root, 'watch.json')); } catch (e) { if (e.code !== 'ENOENT') throw e }
  let stoodDown = false;
  try { fs.statSync(path.join(root, 'taken-over.json')); stoodDown = true; } catch (e) { if (e.code !== 'ENOENT') throw e }
  let takenOver = null;
  try { takenOver = readJson(path.join(root, 'taken-over.json')); } catch (e) { if (e.code !== 'ENOENT') throw e }
  let worker = null;
  try { worker = readJson(path.join(root, 'shared-owner.lock')); } catch (e) { if (e.code !== 'ENOENT') throw e }
  let health = null;
  try { health = readJson(path.join(root, 'health.json')); } catch (e) { if (e.code !== 'ENOENT') throw e }
  let failure = null;
  try { failure = readJson(path.join(root, 'supervisor', 'failure.json')); } catch (e) { if (e.code !== 'ENOENT') throw e }
  const workerPid = worker && Number.isSafeInteger(worker.pid) && worker.pid > 0 ? worker.pid : null;
  found.push({
    agentId: config.session.agentId,
    root,
    running: !!(owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && alive(owner.pid)),
    build: owner && typeof owner.build === 'string' ? owner.build : null,
    enabled: watch ? watch.enabled === true : null,
    spawn: watch ? watch.spawn === true : null,
    stoodDown,
    supervisorPid: owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 ? owner.pid : null,
    workerPid,
    workerAlive: workerPid !== null && alive(workerPid),
    health,
    failure: failure && typeof failure.message === 'string' ? failure.message : null,
    takenOver: takenOver && typeof takenOver.reason === 'string'
      ? { at: String(takenOver.at ?? ''), reason: takenOver.reason }
      : null,
  });
}
process.stdout.write(JSON.stringify(found));
`;

const statusSchema = z.array(
  z.object({
    agentId: z.string(),
    root: z.string(),
    running: z.boolean(),
    build: z.string().nullable(),
    enabled: z.boolean().nullable(),
    spawn: z.boolean().nullable(),
    stoodDown: z.boolean(),
    supervisorPid: z.number().int().positive().nullable(),
    /** The watcher process itself, from `shared-owner.lock`, and whether it is alive. */
    workerPid: z.number().int().positive().nullable(),
    workerAlive: z.boolean(),
    /**
     * What the watcher last wrote about its connection to Switch, or null
     * from a sidecar that does not write it. Unparsed here: see
     * `watcherHealthFileSchema`, applied where it is read.
     */
    health: z.unknown(),
    failure: z.string().nullable(),
    takenOver: z.object({ at: z.string(), reason: z.string() }).nullable(),
  })
);

export type HostWatcherStatus = z.infer<typeof statusSchema>[number];

/** Every watcher on the host this context reaches, keyed by Switch agent id. */
export async function listHostWatchers(
  ctx: IExecutionContext
): Promise<Map<string, HostWatcherStatus>> {
  const { stdout } = await ctx.exec('node', ['-e', WATCHER_STATUS_SCRIPT, '']);
  return new Map(statusSchema.parse(JSON.parse(stdout)).map((entry) => [entry.agentId, entry]));
}

/**
 * Whether bringing this watcher up would change anything.
 *
 * The bar is deliberately high, because the two ways of being wrong are not
 * symmetric. Saying "needs work" when it does not costs a bring-up that ends
 * in the launcher declining to restart anything — the behaviour we have
 * today. Saying "current" when it is not leaves the agent off the air with
 * nothing to notice, which is worse than the cost this exists to avoid. So
 * anything unknown, absent or unexpected counts as needing work.
 *
 * The build is compared by *filename*. The host records the entrypoint path
 * it launched, and that filename carries the bundle's content hash, so equal
 * filenames mean equal code — without this side having to resolve the remote
 * home directory first, which would cost the round trip this exists to save.
 */
export function watcherIsCurrent(
  status: HostWatcherStatus | undefined,
  want: { bundleFile: string; enabled: boolean; spawn: boolean }
): boolean {
  if (!status) return false;
  // A watcher that stood down for another client is left alone by a restore,
  // but its state is not ours to reason about: defer to the normal path.
  if (status.stoodDown) return false;
  if (!status.running) return false;
  if (!status.build || status.build.split('/').pop() !== want.bundleFile) return false;
  return status.enabled === want.enabled && status.spawn === want.spawn;
}
