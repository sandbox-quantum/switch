import { setTimeout as delay } from 'node:timers/promises';
import type { SweepResult } from './rest';

/** A process as the ownership marker lists it (`owner-marker.ts`'s `ProcessEntry`). */
export type OwnedProcess = { pid: number; startTicks: number; owner: string | null };

/** What the ownership marker can do, as a sweep uses it (`owner-marker.ts`). */
export type OwnedProcessOps<Entry extends OwnedProcess> = {
  /** The processes proven to be the agent's, the controller and pid 1 left out (`processesOf`). */
  find: () => Promise<Entry[]>;
  /** Signals the one process, after checking again that it is the one listed and still the agent's (`signalProven`). */
  signal: (
    entry: Entry,
    signal: 'SIGTERM' | 'SIGKILL'
  ) => Promise<'signalled' | 'gone' | 'not_proven'>;
};

const POLL_MS = 250;

/**
 * Ends what a stopped agent left running: every
 * process its ownership marker proves to be the agent's, including any that
 * escaped its tree and was reparented to pid 1. Each is asked to end first,
 * and made to after `graceMs` if it has not. Proof is checked again right
 * before each signal, so an id that has passed to another process is never
 * signalled. A process whose proof fails at the ask is not made to end
 * either: it is counted, for the log, and left running.
 * Nothing is chosen by name, and nothing without proof is touched.
 */
export async function sweepOwned<Entry extends OwnedProcess>(
  ops: OwnedProcessOps<Entry>,
  graceMs: number,
  wait: (ms: number) => Promise<void> = (ms) => delay(ms)
): Promise<SweepResult> {
  const result: SweepResult = { signalled: 0, killed: 0, gone: 0, notProven: 0 };
  const asked: Entry[] = [];
  for (const entry of await ops.find()) {
    const outcome = await ops.signal(entry, 'SIGTERM');
    if (outcome === 'signalled') {
      result.signalled++;
      asked.push(entry);
    } else if (outcome === 'gone') result.gone++;
    else result.notProven++;
  }
  if (!asked.length) return result;
  const key = (entry: OwnedProcess) => `${entry.pid}:${entry.startTicks}`;
  const waiting = new Set(asked.map(key));
  for (let waited = 0; waited < graceMs && waiting.size; waited += POLL_MS) {
    await wait(POLL_MS);
    const still = new Set((await ops.find()).map(key));
    for (const id of [...waiting]) if (!still.has(id)) waiting.delete(id);
  }
  for (const entry of asked) {
    if (!waiting.has(key(entry))) continue;
    const outcome = await ops.signal(entry, 'SIGKILL');
    if (outcome === 'signalled') result.killed++;
    else if (outcome === 'not_proven') result.notProven++;
  }
  return result;
}
