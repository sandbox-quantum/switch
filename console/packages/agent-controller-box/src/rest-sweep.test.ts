import { describe, expect, it } from 'vitest';
import { type OwnedProcess, sweepOwned } from './rest-sweep';

const AGENT = 'agent-1';

/**
 * A pretend `/proc` for one resting agent: the processes the marker proves
 * to be its, and what each does when signalled. Signals re-check proof and
 * start time, as `signalProven` does.
 */
function box(
  processes: (OwnedProcess & {
    /** Ends on SIGTERM; otherwise only SIGKILL ends it. */
    endsOnTerm?: boolean;
    /** Its marker no longer proves it when checked again. */
    proofLost?: boolean;
    /** Ended before the sweep signalled it. */
    endedEarly?: boolean;
    /** Its id passed to another process before the sweep signalled it. */
    reused?: boolean;
  })[]
) {
  const running = new Map(processes.map((entry) => [entry.pid, { ...entry }]));
  const signals: [number, string][] = [];
  return {
    signals,
    running,
    ops: {
      find: async () =>
        [...running.values()]
          .filter((entry) => entry.owner === AGENT && !entry.endedEarly)
          .map(({ pid, startTicks, owner }) => ({ pid, startTicks, owner })),
      signal: async (entry: OwnedProcess, signal: 'SIGTERM' | 'SIGKILL') => {
        const now = running.get(entry.pid);
        if (!now || now.endedEarly || now.reused || now.startTicks !== entry.startTicks)
          return 'gone' as const;
        if (now.proofLost || now.owner !== AGENT) return 'not_proven' as const;
        signals.push([entry.pid, signal]);
        if (signal === 'SIGKILL' || now.endsOnTerm) running.delete(entry.pid);
        return 'signalled' as const;
      },
    },
  };
}

const noWait = async () => {};

describe('sweepOwned', () => {
  it('asks each of the agent’s processes to end, and leaves it at that when they do', async () => {
    const { ops, signals, running } = box([
      { pid: 301, startTicks: 9100, owner: AGENT, endsOnTerm: true },
      { pid: 302, startTicks: 9101, owner: AGENT, endsOnTerm: true },
    ]);
    const result = await sweepOwned(ops, 5_000, noWait);
    expect(result).toEqual({ signalled: 2, killed: 0, gone: 0, notProven: 0 });
    expect(signals).toEqual([
      [301, 'SIGTERM'],
      [302, 'SIGTERM'],
    ]);
    expect(running.size).toBe(0);
  });

  it('makes a detached server that ignores the ask end after the grace, once reparented to pid 1', async () => {
    const { ops, signals, running } = box([
      // A background server the agent started with setsid; its parent is now tini.
      { pid: 412, startTicks: 12_345, owner: AGENT, endsOnTerm: false },
    ]);
    const result = await sweepOwned(ops, 5_000, noWait);
    expect(result).toEqual({ signalled: 1, killed: 1, gone: 0, notProven: 0 });
    expect(signals).toEqual([
      [412, 'SIGTERM'],
      [412, 'SIGKILL'],
    ]);
    expect(running.size).toBe(0);
  });

  it('never signals an id that passed to another process, nor one whose proof fails, and never forces one it could not ask', async () => {
    const { ops, signals, running } = box([
      { pid: 501, startTicks: 1, owner: AGENT, reused: true },
      { pid: 502, startTicks: 2, owner: AGENT, proofLost: true },
    ]);
    const result = await sweepOwned(ops, 5_000, noWait);
    expect(result).toEqual({ signalled: 0, killed: 0, gone: 1, notProven: 1 });
    expect(signals).toEqual([]);
    expect(running.has(502)).toBe(true);
  });

  it('does not force a process whose proof fails after it was asked; it is counted and left running', async () => {
    const { ops, signals, running } = box([
      { pid: 601, startTicks: 3, owner: AGENT, endsOnTerm: false },
    ]);
    const signal = ops.signal;
    let asked = false;
    const result = await sweepOwned(
      {
        find: ops.find,
        signal: async (entry, which) => {
          const outcome = await signal(entry, which);
          if (which === 'SIGTERM') {
            asked = true;
            running.get(601)!.proofLost = true;
          }
          return outcome;
        },
      },
      5_000,
      noWait
    );
    expect(asked).toBe(true);
    expect(result).toEqual({ signalled: 1, killed: 0, gone: 0, notProven: 1 });
    expect(signals).toEqual([[601, 'SIGTERM']]);
    expect(running.has(601)).toBe(true);
  });

  it('touches nothing that is not the agent’s', async () => {
    const { ops, signals } = box([
      { pid: 1, startTicks: 0, owner: null },
      { pid: 700, startTicks: 5, owner: 'agent-2', endsOnTerm: true },
      { pid: 701, startTicks: 6, owner: null, endsOnTerm: true },
    ]);
    const result = await sweepOwned(ops, 5_000, noWait);
    expect(result).toEqual({ signalled: 0, killed: 0, gone: 0, notProven: 0 });
    expect(signals).toEqual([]);
  });

  it('waits no longer than the grace for a process that will not end', async () => {
    const { ops } = box([{ pid: 800, startTicks: 7, owner: AGENT, endsOnTerm: false }]);
    let waited = 0;
    await sweepOwned(ops, 5_000, async (ms) => void (waited += ms));
    expect(waited).toBe(5_000);
  });
});
