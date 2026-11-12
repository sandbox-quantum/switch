import { describe, expect, it } from 'vitest';
import { FIRST_SIGHT_DEPTH, FirstSight, OPERATOR, type SeenProcess } from './first-sight';

const X = 'agent-x';
const Y = 'agent-y';
const p = (pid: number, ppid: number, startTicks: number, owner: string | null): SeenProcess => ({
  pid,
  ppid,
  startTicks,
  owner,
});
const hostX = p(100, 1, 1000, X);
const hostY = p(200, 1, 1100, Y);
const hosts = new Map([
  [X, hostX],
  [Y, hostY],
]);

describe('FirstSight', () => {
  it("counts a host's descendants to it, and keeps an orphan as its agent's after it is reparented", () => {
    const sight = new FirstSight();
    const tool = p(101, 100, 1200, X);
    sight.observe([hostX, hostY, tool], hosts);
    // The tool detaches and is reparented to pid 1.
    const orphan = p(101, 1, 1200, X);
    sight.observe([hostX, hostY, orphan], hosts);
    expect(sight.attribute(orphan)).toEqual({ agentId: X, disputed: false });
  });

  it("ancestry wins: X's tool carrying Y's marker counts to X and is ended with X, never with Y (C8a)", () => {
    const sight = new FirstSight();
    const sneaky = p(102, 100, 1300, Y);
    sight.observe([hostX, hostY, sneaky], hosts);
    expect(sight.attribute(sneaky)).toEqual({ agentId: X, disputed: false });
    expect(sight.toEnd([hostX, hostY, sneaky], X).map((q) => q.pid)).toEqual([100, 102]);
    expect(sight.toEnd([hostX, hostY, sneaky], Y).map((q) => q.pid)).toEqual([200]);
  });

  it('a process first seen outside every tree counts to its marker, disputed, and is ended with that agent', () => {
    const sight = new FirstSight();
    const stray = p(300, 1, 1400, Y);
    sight.observe([hostX, hostY, stray], hosts);
    expect(sight.attribute(stray)).toEqual({ agentId: Y, disputed: true });
    expect(sight.toEnd([hostX, hostY, stray], Y).map((q) => q.pid)).toEqual([200, 300]);
    expect(sight.attribute(p(301, 1, 1500, null))).toEqual({ agentId: null, disputed: false });
  });

  it('a pid reused by a newer process is a stranger, not its old self, and a reused parent pid is not its parent', () => {
    const sight = new FirstSight();
    sight.observe([hostX, hostY, p(103, 100, 1600, X)], hosts);
    // 103 ends; its pid goes to an unmarked process started outside any tree.
    const reused = p(103, 1, 9000, null);
    sight.observe([hostX, hostY, reused], hosts);
    expect(sight.attribute(reused)).toEqual({ agentId: null, disputed: false });
    // A child whose recorded parent pid now names a younger process.
    const child = p(104, 500, 2000, null);
    sight.observe([hostX, hostY, p(500, 100, 2500, X), child], hosts);
    expect(sight.attribute(child)).toEqual({ agentId: null, disputed: false });
  });

  it('never re-attributes: a process first seen as no one’s stays no one’s when it later sits under a host', () => {
    const sight = new FirstSight();
    const loner = p(400, 1, 1700, null);
    sight.observe([hostX, hostY, loner], hosts);
    sight.observe([hostX, hostY, p(400, 100, 1700, null)], hosts);
    expect(sight.attribute(loner)).toEqual({ agentId: null, disputed: false });
  });

  it('walks a chain far deeper than the stack would allow, without recursion, and settles every link', () => {
    const sight = new FirstSight();
    // 50,000 tools, each the child of the last, under X's host: a recursive walk would overflow.
    const chain: SeenProcess[] = [];
    let parent = hostX;
    for (let i = 0; i < 50_000; i++) {
      const next = p(1_000 + i, parent.pid, 2_000 + i, null);
      chain.push(next);
      parent = next;
    }
    // Given youngest first, the worst order for a walk.
    sight.observe([...chain].reverse().concat([hostX]), hosts);
    expect(sight.attribute(chain[chain.length - 1]!)).toEqual({ agentId: X, disputed: false });
    expect(sight.attribute(chain[0]!)).toEqual({ agentId: X, disputed: false });
  });

  it('makes no claim past the depth cap: only the process walked from claims no one', () => {
    const sight = new FirstSight();
    // Equal start times, given deepest first: the deepest is walked before any
    // parent is settled, so its walk passes the cap.
    const chain: SeenProcess[] = [];
    let parent: SeenProcess = hostX;
    for (let i = 0; i <= FIRST_SIGHT_DEPTH + 1; i++) {
      const next = p(10_000 + i, parent.pid, 5_000, null);
      chain.push(next);
      parent = next;
    }
    sight.observe([...chain].reverse().concat([hostX]), hosts);
    expect(sight.attribute(chain[chain.length - 1]!)).toEqual({ agentId: null, disputed: false });
    // The rest were walked from themselves and settled.
    expect(sight.attribute(chain[chain.length - 3]!).agentId).toBe(X);
    expect(sight.attribute(chain[0]!).agentId).toBe(X);
  });

  it('puts an operator’s exec (parent pid 0) and its whole tree in the operator bucket only when asked, never tini', () => {
    const tini = p(1, 0, 1, null);
    const shell = p(50, 0, 3_000, null);
    const child = p(51, 50, 3_100, null);
    const on = new FirstSight();
    on.observe([tini, shell, child, hostX], hosts, true);
    expect(on.attribute(shell)).toEqual({ agentId: OPERATOR, disputed: false });
    expect(on.attribute(child)).toEqual({ agentId: OPERATOR, disputed: false });
    expect(on.attribute(tini).agentId).toBeNull();
    // Never ended for any agent's stop.
    expect(on.toEnd([shell, child], X)).toEqual([]);
    const off = new FirstSight();
    off.observe([tini, shell, child, hostX], hosts);
    expect(off.attribute(shell).agentId).toBeNull();
    expect(off.attribute(child).agentId).toBeNull();
  });
});
