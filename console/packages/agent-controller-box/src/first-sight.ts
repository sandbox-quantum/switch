import type { ProcessEntry } from './owner-marker';

/**
 * Whose a process is by where it was first seen (on a split box, by the
 * launcher).
 *
 * A marker in the environment can be copied by any process of the same user,
 * so it alone can't settle whose a process is. Ancestry can, if it is taken
 * early: the launcher records, the first time it sees each process, the agent
 * whose tree it was under then (its parent's agent, or the agent whose host
 * it is). That record is never changed later, so a process that detaches and
 * is reparented keeps the agent it was first seen under.
 *
 * - **Counting:** a process counts to its first-sight agent; with none (seen
 *   only after it had already left any tree), to its marker's agent, and then
 *   it is **disputed**: added to that agent's total but never, alone, the
 *   reason that agent is stopped.
 * - **Stopping (C8a, ancestry wins):** stopping an agent ends every process
 *   first seen under its tree, whatever marker it carries, plus the disputed
 *   ones carrying its marker. A process first seen under another agent's tree
 *   is never ended for this one, whatever marker it carries.
 */

/** A process, as `listProcesses` gives it: `owner` is the agent its marker proves. */
export type SeenProcess = Pick<ProcessEntry, 'pid' | 'ppid' | 'startTicks' | 'owner'>;

export type Attribution = {
  /** The agent it counts to, or null for no one's. */
  agentId: string | null;
  /** Counted by its marker alone, with no first sight under any agent's tree. */
  disputed: boolean;
};

const key = (process: Pick<SeenProcess, 'pid' | 'startTicks'>) =>
  `${process.pid}:${process.startTicks}`;

/**
 * The bucket for an operator's exec on a test box: a process the container
 * runtime started from outside (parent pid 0, other than pid 1) and its whole
 * tree. Never an agent's and never a stranger; its bytes count to the box.
 * Agent ids are UUIDs, so this can't collide with one.
 */
export const OPERATOR = 'operator';

/** The longest parent chain walked for one process; past it, no claim. */
export const FIRST_SIGHT_DEPTH = 4_096;

export class FirstSight {
  /** Each process ever seen, by pid and start time: the agent whose tree it was first seen under. */
  private readonly seen = new Map<string, string | null>();

  /**
   * Takes a scan. `hosts` names, for each agent, the process the launcher
   * started as its host (its top process): those, and every process first seen
   * below one of them, are that agent's. A process is attributed when first
   * seen and never again; processes gone from the scan are forgotten.
   */
  observe(
    scan: readonly SeenProcess[],
    hosts: ReadonlyMap<string, Pick<SeenProcess, 'pid' | 'startTicks'>>,
    /** Test boxes with operator exec on: parent-pid-0 trees are the operator's (`OPERATOR`). */
    operatorExec = false
  ): void {
    const hostOf = new Map<string, string>();
    for (const [agentId, host] of hosts) hostOf.set(key(host), agentId);
    // Only the runtime can start a process whose parent is outside the
    // container (pid 0); pid 1 (tini) is the container's own.
    if (operatorExec)
      for (const process of scan)
        if (process.ppid === 0 && process.pid !== 1 && !hostOf.has(key(process)))
          hostOf.set(key(process), OPERATOR);
    const byPid = new Map(scan.map((process) => [process.pid, process]));
    /**
     * Walks up from `process` iteratively (never recursion, so a deep chain
     * can't exhaust the stack), at most `FIRST_SIGHT_DEPTH` steps, to the
     * first process already attributed or a host. Everything on the way is
     * attributed to that answer; a chain past the cap, a cycle in a torn
     * scan, or a reused pid makes no claim.
     */
    const firstSight = (process: SeenProcess): void => {
      const chain: string[] = [];
      const onChain = new Set<string>();
      let current: SeenProcess | undefined = process;
      let answer: string | null = null;
      while (current) {
        const k = key(current);
        if (this.seen.has(k)) {
          answer = this.seen.get(k)!;
          break;
        }
        const host = hostOf.get(k);
        if (host !== undefined) {
          answer = host;
          chain.push(k);
          break;
        }
        if (chain.length >= FIRST_SIGHT_DEPTH) {
          // Too deep to settle from here: only the process asked about makes no
          // claim; the ones above it are settled when walked from themselves.
          this.seen.set(key(process), null);
          return;
        }
        if (onChain.has(k)) {
          answer = null;
          break;
        }
        chain.push(k);
        onChain.add(k);
        const parent = byPid.get(current.ppid);
        // A parent that started after its child is a reused pid, not the parent.
        current = parent && parent.startTicks <= current.startTicks ? parent : undefined;
      }
      for (const k of chain) this.seen.set(k, answer);
    };
    // Oldest first, so a parent is settled before its children and each walk is short.
    for (const process of [...scan].sort((a, b) => a.startTicks - b.startTicks))
      firstSight(process);
    const live = new Set(scan.map(key));
    for (const k of [...this.seen.keys()]) if (!live.has(k)) this.seen.delete(k);
  }

  /** Whose `process` is, by first sight, then by marker as disputed. */
  attribute(process: SeenProcess): Attribution {
    const first = this.seen.get(key(process)) ?? null;
    if (first !== null) return { agentId: first, disputed: false };
    return { agentId: process.owner, disputed: process.owner !== null };
  }

  /**
   * The processes to end when `agentId` is stopped: those first seen under its
   * tree, whatever their marker, and the disputed ones carrying its marker.
   */
  toEnd(scan: readonly SeenProcess[], agentId: string): SeenProcess[] {
    if (agentId === OPERATOR) return [];
    return scan.filter((process) => {
      const first = this.seen.get(key(process)) ?? null;
      return first === agentId || (first === null && process.owner === agentId);
    });
  }
}
