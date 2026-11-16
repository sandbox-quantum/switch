import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  anonymousBytes,
  anonymousBytesIn,
  anonymousKiB,
  boxMemoryFromMeminfo,
  DEFAULT_LIMITS,
  endProven,
  freezeRunaway,
  type GuardDecision,
  GuardJudge,
  guardLimitsFromEnv,
  GuardStatus,
  hostAnnouncer,
  type GuardSample,
  MemoryGuard,
  readAgentMemory,
  readBoxMemory,
  usedFromMeminfo,
  readGuardStop,
  SHED_PAUSE_MAX_MS,
  stopDetail,
  stopForMemory,
} from './memory-guard';
import { OwnerMarkers, ProcReader } from './owner-marker';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
/** Box A's and B's limit (6 GiB), as `SWITCH_BOX_MEMORY_LIMIT_BYTES` sets it. */
const BOX = 6 * GIB;
const limits = { boxLimit: BOX, ...DEFAULT_LIMITS };

/*
 * Recorded figures these tests replay (box A, 27 Oct unless said):
 * - 12:46Z, read-only, 3 sessions awake: gVisor's box-wide AnonPages 1,034 MiB;
 *   `Anonymous` summed from smaps: the controller about 243 MiB, each host or
 *   worker 80-117 MiB (pid 103: 78,332 kB).
 * - WL-1, inside: about 190 MiB per awake conversation (the Claude CLI and its session host).
 * - WL-2 (12:16-12:25Z): one zod build, 1,673 MiB before, peak 2,731 MiB (12:18:19).
 * - The hog run (26 Oct): the hog allocates 200 MiB every 2 s (`hog.py`), and the box was
 *   killed about 60 s after it started.
 */
const A_BOX_ANON = 1034 * MIB;
const HOST = 117 * MIB;
const WORKER = 80 * MIB;
const AWAKE_CONVERSATION = 190 * MIB;
const IDLE_AGENT = HOST + WORKER;
const AWAKE_AGENT = IDLE_AGENT + AWAKE_CONVERSATION;
const HOG_STEP = 200 * MIB;

function sample(box: number, agents: Record<string, number>): GuardSample {
  return { box, agents: new Map(Object.entries(agents)) };
}

describe('anonymousBytes', () => {
  it("sums every mapping's Anonymous line, as gVisor writes smaps", () => {
    const smaps = [
      '00400000-00b1c000 r-xp 00000000 00:05 12 /usr/local/bin/node',
      'Size:               7280 kB',
      'Rss:                7280 kB',
      'Pss:                7280 kB',
      'Shared_Clean:          0 kB',
      'Private_Dirty:         0 kB',
      'Anonymous:             0 kB',
      '7f1c2a000000-7f1c2e000000 rw-p 00000000 00:00 0',
      'Size:              65536 kB',
      'Rss:               61440 kB',
      'Pss:               61440 kB',
      'Private_Dirty:     61312 kB',
      'Anonymous:         61440 kB',
      '7ffd0c3e0000-7ffd0c401000 rw-p 00000000 00:00 0 [stack]',
      'Anonymous:           132 kB',
      '',
    ].join('\n');
    expect(anonymousBytes(smaps)).toBe((61440 + 132) * 1024);
    expect(anonymousBytes('')).toBe(0);
  });
});

describe('boxMemoryFromMeminfo', () => {
  it('reads AnonPages, Shmem and MemTotal, and gives null when one is missing', () => {
    const meminfo = [
      'MemTotal:        6291456 kB',
      'MemFree:         4921344 kB',
      'AnonPages:        940496 kB',
      'Shmem:              4096 kB',
      '',
    ].join('\n');
    expect(boxMemoryFromMeminfo(meminfo)).toEqual({
      anon: 940496 * 1024,
      shmem: 4096 * 1024,
      total: 6291456 * 1024,
    });
    expect(boxMemoryFromMeminfo('MemTotal: 6291456 kB\n')).toBeNull();
  });
});

describe('GuardJudge', () => {
  it("stops the hog run's hog on the second sample past its share, before the box fills, and no one else", () => {
    const judge = new GuardJudge(limits);
    const decisions: GuardDecision[] = [];
    let hog = 0;
    let at = 0;
    // Four other agents awake, as in the hog run; user-a-engineer runs the hog.
    for (; at < 30; at++) {
      const engineer = AWAKE_AGENT + hog;
      const others = {
        lead: AWAKE_AGENT,
        pm: AWAKE_AGENT,
        designer: AWAKE_AGENT,
        platform: AWAKE_AGENT,
      };
      const decision = judge.judge(
        sample(A_BOX_ANON + AWAKE_CONVERSATION * 2 + hog, { ...others, engineer })
      );
      decisions.push(decision);
      if (decision.kind === 'stop') break;
      hog += HOG_STEP;
    }
    const stop = decisions.at(-1)!;
    expect(stop).toMatchObject({ kind: 'stop', agentId: 'engineer', trigger: 'share' });
    expect(decisions.slice(0, -1).every((decision) => decision.kind === 'none')).toBe(true);
    const share = Math.floor(BOX * 0.6);
    // The sample before was already over its share: two in a row.
    expect(AWAKE_AGENT + hog - HOG_STEP).toBeGreaterThan(share);
    expect(AWAKE_AGENT + hog - 2 * HOG_STEP).toBeLessThanOrEqual(share);
    // Stopped 36 s in, well inside the 60 s the hog run's box lasted, and under the backstop.
    expect(at * 2).toBeLessThan(60);
    expect(A_BOX_ANON + AWAKE_CONVERSATION * 2 + hog).toBeLessThan(BOX * 0.92);
    expect(stop.kind === 'stop' && stopDetail(stop)).toBe(
      'Stopped by the memory guard at 3.9 GiB (its limit is 3.6 GiB).'
    );
  });

  it("does not stop WL-2's build, which stays well under its share", () => {
    // Box A's inside reads during the zod build, 12:16:43-12:25:04Z, AnonPages
    // in KiB (the three reads
    // that timed out at 12:21:54-12:22:54 are left out, as the file has none).
    // The builder carries the whole rise above the first read, read 20% high;
    // the four other agents rest. Then the host view's peak (3,380 MiB) as the box.
    const series = [
      1712676, 1861260, 1853900, 2260084, 2530516, 1753288, 2796048, 2291552, 2079292, 2321396,
      2097572, 2109340, 2177904, 2447944, 1737104, 1740348, 1740968, 1741148, 1742076,
    ];
    const judge = new GuardJudge(limits);
    const others = { lead: IDLE_AGENT, pm: IDLE_AGENT, designer: IDLE_AGENT, platform: IDLE_AGENT };
    for (const kib of series) {
      const builder = AWAKE_AGENT + (kib - series[0]!) * 1024 * 1.2;
      expect(judge.judge(sample(kib * 1024, { ...others, builder })).kind).toBe('none');
    }
    const peak = AWAKE_AGENT + (2796048 - series[0]!) * 1024 * 1.2;
    expect(judge.judge(sample(3380 * MIB, { ...others, builder: peak })).kind).toBe('none');
  });

  it("does not stop anyone through WL-3's recorded run: five agents awake and fetching", () => {
    // Box A's in-box sampler, 12:52:50-12:57:51Z, AnonPages in KiB, every 10 s
    // (the rerun). Each agent's figure is
    // its fifth of everything above the controller, read 20% high as summed
    // `Anonymous` reads against AnonPages (box A, 12:46Z).
    const series = [
      1058472, 1061692, 2286496, 2544396, 2588836, 2553608, 2570672, 2652656, 2658564, 2667932,
      2685124, 2649024, 2615372, 2545292, 2479120, 2415440, 2416016, 2349524, 2336656, 2336832,
      2335680, 2259424, 2222148, 2192172, 2190776, 2189748, 2186360, 2185920, 2185476, 2185972,
      2186248,
    ];
    const judge = new GuardJudge(limits);
    for (const kib of series) {
      const box = kib * 1024;
      const each = ((box - 243 * MIB) / 5) * 1.2;
      const agents = { lead: each, pm: each, designer: each, engineer: each, platform: each };
      expect(judge.judge(sample(box, agents)).kind).toBe('none');
    }
  });

  it("does not stop anyone through WL-3's run split unevenly, one agent doing most of the fetching", () => {
    const series = [
      1058472, 1061692, 2286496, 2544396, 2588836, 2553608, 2570672, 2652656, 2658564, 2667932,
      2685124, 2649024, 2615372, 2545292, 2479120, 2415440, 2416016, 2349524, 2336656, 2336832,
      2335680, 2259424, 2222148, 2192172, 2190776, 2189748, 2186360, 2185920, 2185476, 2185972,
      2186248,
    ];
    const judge = new GuardJudge(limits);
    const shares = { lead: 0.4, pm: 0.25, designer: 0.15, engineer: 0.1, platform: 0.1 };
    for (const kib of series) {
      const box = kib * 1024;
      const above = (box - 243 * MIB) * 1.2;
      const agents = Object.fromEntries(
        Object.entries(shares).map(([agentId, part]) => [agentId, above * part])
      );
      expect(judge.judge(sample(box, agents)).kind).toBe('none');
    }
  });

  it('does not stop for one spike over its share that falls back by the next sample', () => {
    const judge = new GuardJudge(limits);
    expect(judge.judge(sample(4 * GIB, { a: 3.7 * GIB })).kind).toBe('none');
    expect(judge.judge(sample(3 * GIB, { a: 3.0 * GIB })).kind).toBe('none');
    expect(judge.judge(sample(4 * GIB, { a: 3.7 * GIB })).kind).toBe('none');
  });

  it('counts an agent whose memory is spread over many small processes as one', () => {
    const judge = new GuardJudge(limits);
    // 30 workers of 120 MiB each under one agent: none large, together past the share.
    const spread = IDLE_AGENT + 30 * 120 * MIB;
    judge.judge(sample(A_BOX_ANON + spread, { spread, quiet: IDLE_AGENT }));
    expect(judge.judge(sample(A_BOX_ANON + spread, { spread, quiet: IDLE_AGENT }))).toMatchObject({
      kind: 'stop',
      agentId: 'spread',
    });
  });

  it('stops the largest agent at once when the box passes 92% and is still rising', () => {
    const judge = new GuardJudge(limits);
    // Three builds at once, none past its share, together filling the box.
    const agents = { a: 2.0 * GIB, b: 1.7 * GIB, c: 1.5 * GIB };
    expect(judge.judge(sample(5.4 * GIB, agents)).kind).toBe('none');
    const stop = judge.judge(sample(5.6 * GIB, { ...agents, a: 2.1 * GIB }));
    expect(stop).toMatchObject({ kind: 'stop', agentId: 'a', trigger: 'backstop', percent: 92 });
    expect(stop.kind === 'stop' && stopDetail(stop)).toBe(
      'Stopped by the memory guard at 2.1 GiB, the largest agent when the box reached 92% of its memory.'
    );
  });

  it('does not blame the largest agent for a rise that memory without a marker explains', () => {
    const judge = new GuardJudge(limits);
    // An `env -i` child holds 2.4 GiB no marker proves; the largest agent is steady.
    const agents = { a: 1.6 * GIB, b: 0.9 * GIB };
    judge.judge(sample(5.0 * GIB, agents));
    expect(judge.judge(sample(5.6 * GIB, agents)).kind).toBe('unexplained');
  });

  it('still stops the largest agent when it carried the rise, whatever else is unproven', () => {
    const judge = new GuardJudge(limits);
    judge.judge(sample(5.0 * GIB, { a: 1.6 * GIB, b: 0.9 * GIB }));
    expect(judge.judge(sample(5.6 * GIB, { a: 2.2 * GIB, b: 0.9 * GIB }))).toMatchObject({
      kind: 'stop',
      agentId: 'a',
      trigger: 'backstop',
    });
  });

  it('does not blame a steady agent for a rise held by an agent being stopped', () => {
    const judge = new GuardJudge(limits);
    // The runaway is being stopped, so it is not a candidate, and it keeps
    // allocating through the announce and the 5 s; the largest candidate is steady.
    judge.judge(sample(5.0 * GIB, { a: 1.6 * GIB }));
    expect(judge.judge(sample(5.6 * GIB, { a: 1.6 * GIB })).kind).toBe('unexplained');
  });

  it('reports a rise spread evenly over several agents rather than pick one', () => {
    const judge = new GuardJudge(limits);
    judge.judge(sample(5.0 * GIB, { a: 1.6 * GIB, b: 1.6 * GIB, c: 1.6 * GIB }));
    expect(judge.judge(sample(5.6 * GIB, { a: 1.8 * GIB, b: 1.8 * GIB, c: 1.8 * GIB })).kind).toBe(
      'unexplained'
    );
  });

  it('still stops an agent over its share while unmarked memory fills the box faster', () => {
    const judge = new GuardJudge(limits);
    // One agent at 70% of the box creeping up; Shmem climbs faster.
    // The box is already past 92% and rising when the second sample comes.
    const a = Math.round(0.7 * BOX);
    expect(judge.judge(sample(5.55 * GIB, { a, b: IDLE_AGENT })).kind).toBe('none');
    expect(judge.judge(sample(5.85 * GIB, { a: a + 20 * MIB, b: IDLE_AGENT }))).toMatchObject({
      kind: 'stop',
      agentId: 'a',
      trigger: 'share',
    });
  });

  it('notes a box that stays above 92% without rising, then stops the largest agent after a minute', () => {
    const judge = new GuardJudge(limits);
    const agents = { leaky: 2.2 * GIB, quiet: IDLE_AGENT };
    const at = (s: number) => s * 1000;
    // A slow leak has carried the box just past 92%, and it sits there.
    expect(
      judge.judge({ box: 5.6 * GIB, agents: new Map(Object.entries(agents)), at: at(0) }).kind
    ).toBe('none');
    expect(
      judge.judge({ box: 5.6 * GIB, agents: new Map(Object.entries(agents)), at: at(2) }).kind
    ).toBe('none');
    expect(
      judge.judge({ box: 5.6 * GIB, agents: new Map(Object.entries(agents)), at: at(4) })
    ).toMatchObject({
      kind: 'unexplained',
      sustainedMs: 4_000,
    });
    let decision: GuardDecision = { kind: 'none' };
    for (let s = 6; s <= 60 && decision.kind !== 'stop'; s += 2)
      decision = judge.judge({
        box: 5.6 * GIB,
        agents: new Map(Object.entries(agents)),
        at: at(s),
      });
    expect(decision).toMatchObject({ kind: 'stop', agentId: 'leaky', trigger: 'sustained' });
    expect(decision.kind === 'stop' && stopDetail(decision)).toBe(
      'Stopped by the memory guard at 2.2 GiB, the largest agent when the box stayed above 92% of its memory for a minute.'
    );
    // The clock starts again after a stop.
    expect(
      judge.judge({ box: 5.6 * GIB, agents: new Map([['quiet', IDLE_AGENT]]), at: at(62) }).kind
    ).toBe('none');
  });

  it('keeps noting, and stops no one, when the box stays high but no agent holds enough to matter', () => {
    const judge = new GuardJudge(limits);
    const agents = new Map([['a', AWAKE_AGENT]]);
    let decision: GuardDecision = { kind: 'none' };
    for (let s = 0; s <= 120; s += 2)
      decision = judge.judge({ box: 5.7 * GIB, agents, at: s * 1000 });
    expect(decision).toMatchObject({ kind: 'unexplained', sustainedMs: 120_000 });
  });

  it('counts the minute while the box stays above 92%, small ups and downs included', () => {
    const judge = new GuardJudge(limits);
    const agents = new Map([['leaky', 2.2 * GIB]]);
    let decision: GuardDecision = { kind: 'none' };
    for (let s = 0; s <= 62 && decision.kind !== 'stop'; s += 2) {
      // Wobbling between 5.55 and 5.65 GiB, never below 92% (5.52 GiB).
      const box = (s / 2) % 2 === 0 ? 5.55 * GIB : 5.65 * GIB;
      decision = judge.judge({ box, agents, at: s * 1000 });
    }
    expect(decision).toMatchObject({ kind: 'stop', agentId: 'leaky', trigger: 'sustained' });
  });

  it('starts the minute again after a stop for another reason, so no one is stopped twice for it', () => {
    const judge = new GuardJudge(limits);
    // 50 s above 92%, then an agent over its share is stopped.
    for (let s = 0; s < 48; s += 2)
      judge.judge({ box: 5.6 * GIB, agents: new Map([['b', 2.2 * GIB]]), at: s * 1000 });
    const over = Math.round(0.65 * BOX);
    judge.judge({
      box: 5.6 * GIB,
      agents: new Map([
        ['a', over],
        ['b', 1.5 * GIB],
      ]),
      at: 48_000,
    });
    expect(
      judge.judge({
        box: 5.6 * GIB,
        agents: new Map([
          ['a', over],
          ['b', 1.5 * GIB],
        ]),
        at: 50_000,
      })
    ).toMatchObject({ kind: 'stop', agentId: 'a', trigger: 'share' });
    // The box stays high as the stopped agent's memory goes: no sustained stop at the old 60 s.
    for (let s = 52; s < 110; s += 2)
      expect(
        judge.judge({ box: 5.6 * GIB, agents: new Map([['b', 2.2 * GIB]]), at: s * 1000 }).kind
      ).not.toBe('stop');
  });

  it('does not stop a second agent after a rise stop, then the box still high as it frees', () => {
    const judge = new GuardJudge(limits);
    const box = (b: number, agents: Record<string, number>, s: number, stopping = false) =>
      judge.judge({
        box: b * GIB,
        agents: new Map(Object.entries(agents)),
        at: s * 1000,
        stopping,
      });
    for (let s = 0; s <= 50; s += 2) box(5.6, { a: 1.6 * GIB, b: 1.8 * GIB }, s);
    expect(box(5.9, { a: 1.9 * GIB, b: 1.8 * GIB }, 52)).toMatchObject({
      kind: 'stop',
      agentId: 'a',
      trigger: 'backstop',
    });
    // a is being stopped and left out; the box frees slowly.
    for (let s = 54; s <= 70; s += 2)
      expect(box(5.7, { b: 1.8 * GIB }, s, true).kind).not.toBe('stop');
    judge.restartClock(72_000); // a's stop has finished
    for (let s = 72; s < 130; s += 2) expect(box(5.6, { b: 1.8 * GIB }, s).kind).not.toBe('stop');
    // Still high a full minute after a's memory went: now b.
    expect(box(5.6, { b: 1.8 * GIB }, 132)).toMatchObject({
      kind: 'stop',
      agentId: 'b',
      trigger: 'sustained',
    });
  });

  it('starts the clock again when the box falls back under 92%', () => {
    const judge = new GuardJudge(limits);
    const agents = new Map([['a', 2.2 * GIB]]);
    for (let s = 0; s < 50; s += 2) judge.judge({ box: 5.6 * GIB, agents, at: s * 1000 });
    judge.judge({ box: 5.0 * GIB, agents, at: 50_000 });
    for (let s = 52; s < 100; s += 2)
      expect(judge.judge({ box: 5.6 * GIB, agents, at: s * 1000 }).kind).not.toBe('stop');
  });

  it('stops no one when the box is past 92% but falling', () => {
    const judge = new GuardJudge(limits);
    const agents = { a: 2.0 * GIB, b: 1.7 * GIB, c: 1.5 * GIB };
    judge.judge(sample(5.7 * GIB, agents));
    expect(judge.judge(sample(5.6 * GIB, agents)).kind).toBe('none');
  });

  it("reports, and stops no one, when the box fills but no agent's processes explain it", () => {
    const judge = new GuardJudge(limits);
    // /dev/shm filled: Shmem climbs, the agents' Anonymous does not.
    const agents = { a: AWAKE_AGENT, b: IDLE_AGENT };
    judge.judge(sample(5.0 * GIB, agents));
    expect(judge.judge(sample(5.7 * GIB, agents))).toEqual({
      kind: 'unexplained',
      box: 5.7 * GIB,
      largest: { agentId: 'a', bytes: AWAKE_AGENT },
    });
  });

  it('forgets an agent that left between samples', () => {
    const judge = new GuardJudge(limits);
    judge.judge(sample(4 * GIB, { a: 3.7 * GIB }));
    judge.judge(sample(1 * GIB, {}));
    expect(judge.judge(sample(4 * GIB, { a: 3.7 * GIB })).kind).toBe('none');
  });
});

describe('readAgentMemory', () => {
  const markers = new OwnerMarkers(Buffer.alloc(32, 3));
  let proc: string;

  beforeEach(() => {
    proc = join(mkdtempSync(join(tmpdir(), 'memory-guard-')), 'proc');
    mkdirSync(proc);
  });
  afterEach(() => rmSync(join(proc, '..'), { recursive: true, force: true }));

  function fake(pid: number, ppid: number, env: string[], anonKiB: number[]): void {
    const at = join(proc, String(pid));
    mkdirSync(at);
    writeFileSync(join(at, 'status'), `Name:\tnode\nTgid:\t${pid}\nPid:\t${pid}\nPPid:\t${ppid}\n`);
    writeFileSync(
      join(at, 'stat'),
      `${pid} (node) S ${ppid} ${pid} ${pid} 0 -1 4194560 812 0 0 0 3 1 0 0 20 0 1 0 ${1000 + pid} 1 \n`
    );
    writeFileSync(join(at, 'environ'), env.map((entry) => `${entry}\0`).join(''));
    writeFileSync(
      join(at, 'smaps'),
      anonKiB
        .map((kib, i) => `0000${i}-0000${i + 1} rw-p 00000000 00:00 0\nAnonymous: ${kib} kB\n`)
        .join('')
    );
  }
  const marker = (agentId: string) => `SWITCH_OWNER_MARKER=${markers.markerFor(agentId)}`;

  it("sums each agent's proven processes, its orphan included, and leaves the rest out", async () => {
    fake(1, 0, [], [512]);
    fake(7, 1, [], [248_832]); // the controller, about 243 MiB
    fake(103, 1, [marker('a')], [78_332, 1_000]);
    fake(104, 103, [marker('a')], [82_000]);
    fake(161, 1, [marker('a')], [204_800]); // an orphan under tini
    fake(201, 1, [marker('b')], [80_000]);
    fake(300, 1, [], [999_999]); // no proof
    const memory = await readAgentMemory(markers, ['a', 'b', 'c'], { procRoot: proc, self: 7 });
    expect(memory.get('a')!.bytes).toBe((78_332 + 1_000 + 82_000 + 204_800) * 1024);
    expect(memory.get('a')!.processes.map((entry) => entry.pid)).toEqual([103, 104, 161]);
    expect(memory.get('b')!.bytes).toBe(80_000 * 1024);
    expect(memory.get('c')).toEqual({ bytes: 0, processes: [] });
  });

  it('reads an Anonymous line from its bytes, and nothing from any other line', () => {
    const kib = (text: string) => {
      const line = Buffer.from(`xx${text}yy`, 'latin1');
      return anonymousKiB(line, 2, line.length - 2);
    };
    expect(kib('Anonymous:          78332 kB')).toBe(78_332);
    expect(kib('Anonymous:\t0 kB')).toBe(0);
    for (const other of [
      'AnonHugePages:      2048 kB',
      'Anonymous:78332 kB',
      'Anonymous:       kB',
      'Anonymous:       12 MB',
      'Anonymous:       12 kB trailing',
      'Anonymous:       1x2 kB',
      ' Anonymous:       12 kB',
      'Rss:              12 kB',
      '',
    ])
      expect(kib(other)).toBeNull();
  });

  it('streams smaps to the same sum as reading it whole, whatever the chunk size', async () => {
    const at = join(proc, 'smaps-only');
    const smaps = Array.from(
      { length: 2_000 },
      (_, i) =>
        `7f00${i}-7f01${i} rw-p 00000000 00:00 0\nSize:  ${i} kB\nRss:  ${i} kB\nAnonymous:  ${i % 97} kB\nVmFlags: rd wr mr mw me ac\n`
    ).join('');
    writeFileSync(at, smaps);
    for (const size of [16, 100, 4096, 64 * 1024])
      expect(await anonymousBytesIn(new ProcReader(size), at)).toEqual({
        bytes: anonymousBytes(smaps),
        complete: true,
      });
  });

  it('measures a process whose smaps is over the cap from VmRSS, never skipping it, and says so', async () => {
    fake(
      103,
      1,
      [marker('a')],
      Array.from({ length: 200 }, () => 10)
    ); // about 9 KB of smaps
    writeFileSync(
      join(proc, '103', 'status'),
      'Name:\tnode\nTgid:\t103\nPid:\t103\nPPid:\t1\nVmRSS:\t  900000 kB\nRssAnon:\t       0 kB\n'
    );
    fake(104, 1, [marker('a')], [8]);
    const told: unknown[][] = [];
    const memory = await readAgentMemory(markers, ['a'], {
      procRoot: proc,
      self: 7,
      smapsMax: 1_000,
      onTooLarge: (...args) => told.push(args),
    });
    // gVisor's RssAnon reads 0; VmRSS errs high, the safe side for choosing whom to stop.
    expect(memory.get('a')!.bytes).toBe((900_000 + 8) * 1024);
    expect(memory.get('a')!.processes.map((entry) => entry.pid)).toEqual([103, 104]);
    expect(told).toEqual([[103, 'smaps', 'a']]);
  });

  it('reads a long environ and smaps whole through one small reused buffer, scan after scan', async () => {
    // A marker past the reader's first buffer, and 3,000 mappings of smaps
    // (about 150 KB): nothing may be cut short when the buffer has to grow.
    const padding = Array.from({ length: 400 }, (_, i) => `PAD_${i}=${'x'.repeat(200)}`);
    fake(
      103,
      1,
      [...padding, marker('a')],
      Array.from({ length: 3_000 }, () => 4)
    );
    fake(104, 1, [marker('a')], [8]); // short, read after the long one through the same buffer
    fake(201, 1, [marker('b'), ...padding], [16]);
    const reader = new ProcReader(64);
    for (let scan = 0; scan < 3; scan++) {
      const memory = await readAgentMemory(
        markers,
        ['a', 'b'],
        { procRoot: proc, self: 7 },
        reader
      );
      expect(memory.get('a')!.bytes).toBe((3_000 * 4 + 8) * 1024);
      expect(memory.get('a')!.processes.map((entry) => entry.pid)).toEqual([103, 104]);
      expect(memory.get('b')!.bytes).toBe(16 * 1024);
    }
  });
});

describe('stopping an agent for memory', () => {
  const markers = new OwnerMarkers(Buffer.alloc(32, 4));
  let root: string;
  let proc: string;
  let clock: number;
  let calls: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memory-guard-stop-'));
    proc = join(root, 'proc');
    mkdirSync(proc);
    clock = 1_000_000;
    calls = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function fake(pid: number, ppid: number, env: string[], anonKiB: number): void {
    const at = join(proc, String(pid));
    mkdirSync(at);
    writeFileSync(join(at, 'status'), `Name:\tnode\nTgid:\t${pid}\nPid:\t${pid}\nPPid:\t${ppid}\n`);
    writeFileSync(
      join(at, 'stat'),
      `${pid} (node) S ${ppid} ${pid} ${pid} 0 -1 4194560 812 0 0 0 3 1 0 0 20 0 1 0 ${1000 + pid} 1 \n`
    );
    writeFileSync(join(at, 'environ'), env.map((entry) => `${entry}\0`).join(''));
    writeFileSync(join(at, 'smaps'), `00-01 rw-p 00000000 00:00 0\nAnonymous: ${anonKiB} kB\n`);
  }
  const marker = (agentId: string) => `SWITCH_OWNER_MARKER=${markers.markerFor(agentId)}`;
  const exit = (pid: number) => rmSync(join(proc, String(pid)), { recursive: true, force: true });

  function deps(
    overrides: {
      ignoresTerm?: number[];
      onSignal?: (pid: number, signal: NodeJS.Signals) => void;
    } = {}
  ) {
    const ignores = new Set(overrides.ignoresTerm ?? []);
    return {
      markers,
      rest: {
        suspend: (agentId: string) => void calls.push(`suspend ${agentId}`),
        stopped: (agentId: string) => void calls.push(`stopped ${agentId}`),
        clear: (agentId: string) => void calls.push(`clear ${agentId}`),
      },
      stopHost: async (agentId: string) => {
        calls.push(`stopHost ${agentId}`);
      },
      agentDir: (agentId: string) => join(root, 'agents', agentId),
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      now: () => clock,
      proc: { procRoot: proc, self: 7 },
      kill: (pid: number, signal: NodeJS.Signals) => {
        calls.push(`${signal} ${pid}`);
        overrides.onSignal?.(pid, signal);
        if (signal === 'SIGKILL' || (signal === 'SIGTERM' && !ignores.has(pid))) exit(pid);
      },
      sleep: async (ms: number) => {
        clock += ms;
      },
    };
  }

  const decision = {
    kind: 'stop' as const,
    agentId: 'hog',
    trigger: 'share' as const,
    bytes: Math.round(3.9 * GIB),
    limit: Math.floor(BOX * 0.6),
    percent: 60,
  };

  it('records, holds, asks every proven process to end, and leaves other agents alone', async () => {
    fake(7, 1, [], 248_832);
    fake(103, 1, [marker('hog')], 117 * 1024);
    fake(161, 1, [marker('hog')], 3_500 * 1024); // the hog, an orphan under tini
    fake(201, 1, [marker('quiet')], 80 * 1024);
    fake(300, 1, [], 50 * 1024);
    const result = await stopForMemory(deps(), decision);
    expect(calls).toEqual([
      'suspend hog',
      'stopHost hog',
      'SIGTERM 103',
      'SIGTERM 161',
      'stopped hog',
    ]);
    expect(result).toMatchObject({ asked: 2, forced: 0, notProven: 0, record: { count: 1 } });
    expect(await readGuardStop(join(root, 'agents', 'hog'))).toMatchObject({
      count: 1,
      last: { bytes: Math.round(3.9 * GIB), trigger: 'share', percent: 60 },
    });
    if (process.platform !== 'win32')
      expect(statSync(join(root, 'agents', 'hog', 'guard-stop.json')).mode & 0o777).toBe(0o600);
  });

  it('forces what ignores the ask after 5 s, and counts every stop', async () => {
    fake(161, 1, [marker('hog')], 3_500 * 1024);
    await stopForMemory(deps(), decision);
    fake(162, 1, [marker('hog')], 3_500 * 1024);
    const started = clock;
    const result = await stopForMemory(deps({ ignoresTerm: [162] }), decision);
    expect(calls.slice(-4)).toEqual(['SIGTERM 162', 'SIGSTOP 162', 'SIGKILL 162', 'stopped hog']);
    expect(clock - started).toBeGreaterThanOrEqual(5_000);
    expect(result).toMatchObject({ asked: 1, forced: 1, record: { count: 2 } });
  });

  it('does not force a process whose proof is gone by then', async () => {
    fake(162, 1, [marker('hog')], 3_500 * 1024);
    const d = deps({ ignoresTerm: [162] });
    const kill = d.kill;
    d.kill = (pid, signal) => {
      kill(pid, signal);
      // It rewrites its environment after the ask: no longer provable.
      if (signal === 'SIGTERM') writeFileSync(join(proc, '162', 'environ'), 'PATH=/bin\0');
    };
    const result = await stopForMemory(d, decision);
    expect(calls).not.toContain('SIGKILL 162');
    expect(result?.forced).toBe(0);
  });

  it('has the host tell its rooms before anything is stopped', async () => {
    fake(161, 1, [marker('hog')], 3_500 * 1024);
    const d = {
      ...deps(),
      announce: async (agentId: string) => {
        calls.push(`announce ${agentId}`);
        return 1;
      },
    };
    const result = await stopForMemory(d, decision);
    expect(calls.slice(0, 3)).toEqual(['suspend hog', 'announce hog', 'stopHost hog']);
    expect(result?.told).toBe(1);
  });

  it('stops anyway, without the line, when the host cannot tell its rooms', async () => {
    fake(161, 1, [marker('hog')], 3_500 * 1024);
    const warned: unknown[] = [];
    const d = {
      ...deps(),
      log: {
        info: () => {},
        warn: (...args: unknown[]) => warned.push(args),
        error: () => {},
        debug: () => {},
      } as never,
      announce: async () => {
        throw new Error('The agent host’s control port did not answer in time.');
      },
    };
    const result = await stopForMemory(d, decision);
    expect(result).toMatchObject({ told: 0, asked: 1 });
    expect(calls).toContain('stopHost hog');
    expect(JSON.stringify(warned)).toContain('could not have the agent tell its rooms');
  });

  it('lets the agent go again if its host cannot be stopped', async () => {
    const d = deps();
    d.stopHost = async () => {
      throw new Error('cannot stop');
    };
    await expect(stopForMemory(d, decision)).rejects.toThrow('cannot stop');
    expect(calls).toEqual(['suspend hog', 'clear hog']);
    // Not a stop: no count is kept.
    expect(await readGuardStop(join(root, 'agents', 'hog'))).toBeNull();
  });

  it('records a slow-leak stop so it reads back after a restart, hold included', async () => {
    fake(161, 1, [marker('hog')], 3_500 * 1024);
    await stopForMemory(deps(), {
      ...decision,
      trigger: 'sustained',
      limit: Math.floor(BOX * 0.92),
      percent: 92,
    });
    expect(await readGuardStop(join(root, 'agents', 'hog'))).toMatchObject({
      held: true,
      last: { trigger: 'sustained', percent: 92 },
    });
  });

  it('goes on with the stop when its record cannot be written', async () => {
    fake(161, 1, [marker('hog')], 3_500 * 1024);
    // The agent turned its record's folder into a file (same user).
    mkdirSync(join(root, 'agents'));
    writeFileSync(join(root, 'agents', 'hog'), 'not a folder');
    const errors: unknown[] = [];
    const d = {
      ...deps(),
      log: {
        info: () => {},
        warn: () => {},
        error: (...args: unknown[]) => errors.push(args),
        debug: () => {},
      } as never,
    };
    const result = await stopForMemory(d, decision);
    expect(result?.asked).toBe(1);
    expect(calls).toContain('stopped hog');
    expect(JSON.stringify(errors)).toContain('could not record a stop');
  });

  it('sends no ask to frozen work, only to the host, and kills the work at once', async () => {
    fake(103, 1, [marker('hog')], 117 * 1024); // the host, awake
    fake(170, 103, [marker('hog')], 3_500 * 1024); // frozen on the decision
    const started = clock;
    const result = await stopForMemory(deps(), decision, { frozen: new Set([170]) });
    expect(calls).toContain('SIGTERM 103');
    expect(calls).not.toContain('SIGTERM 170');
    expect(calls).toContain('SIGKILL 170');
    // No 5 s wait on work that could not act on an ask.
    expect(clock - started).toBeLessThan(5_000);
    expect(result?.asked).toBe(1);
  });

  it('skips the stop, and lets frozen work go on, if the agent changed while queued', async () => {
    fake(170, 1, [marker('hog')], 3_500 * 1024);
    const result = await stopForMemory(deps(), decision, { stillWanted: () => false });
    expect(result).toBeNull();
    expect(calls).toEqual(['SIGCONT 170']);
    expect(await readGuardStop(join(root, 'agents', 'hog'))).toBeNull();
  });

  it('lets frozen work go on when the queue itself fails', async () => {
    fake(161, 1, [marker('hog')], 3_800 * 1024);
    const guard = new MemoryGuard({
      ...deps(),
      limits,
      watched: () => ['hog'],
      held: () => null,
      run: async () => {
        throw new Error('queue closed');
      },
      onStopped: () => {},
      readBox: async () => ({ bytes: 4.5 * GIB, shmem: 0 }),
    });
    await guard.tick();
    await guard.tick();
    await guard.settled();
    expect(calls).toEqual(['SIGSTOP 161', 'SIGCONT 161']);
  });

  it('freezes the runaway at once, leaving the host awake to post', async () => {
    fake(103, 1, [marker('hog')], 117 * 1024); // the supervisor
    fake(104, 103, [marker('hog')], 80 * 1024); // the worker, which posts
    fake(170, 104, [marker('hog')], 3_500 * 1024); // the runaway build
    const frozen = await freezeRunaway({ ...deps(), hostPids: async () => [103, 104] }, 'hog');
    expect([...frozen]).toEqual([170]);
    expect(calls).toEqual(['SIGSTOP 170']);
  });

  it('stops ending leftovers, and lets frozen ones go on, once the agent wakes', async () => {
    fake(161, 1, [marker('hog')], 900 * 1024);
    let held = true;
    const d = deps({
      onSignal: (_pid, signal) => {
        if (signal === 'SIGSTOP') held = false; // its next message arrives right then
      },
    });
    const ended = await endProven(markers, 'hog', {
      ...d.proc,
      kill: d.kill,
      sleep: d.sleep,
      still: () => held,
    });
    expect(ended.forced).toBe(0);
    expect(calls).toEqual(['SIGSTOP 161', 'SIGCONT 161']);
    expect(existsSync(join(proc, '161'))).toBe(true);
  });

  it('kills what forks, or is restarted, while the stop is under way', async () => {
    fake(103, 1, [marker('hog')], 117 * 1024); // the supervisor
    fake(104, 103, [marker('hog')], 80 * 1024); // its worker, which ignores the ask
    fake(170, 104, [marker('hog')], 3_500 * 1024); // a build that forks as it dies
    let forked = false;
    const d = deps({
      ignoresTerm: [104, 170],
      onSignal: (pid, signal) => {
        // The supervisor restarts its worker as it goes.
        if (pid === 103 && signal === 'SIGTERM') fake(105, 1, [marker('hog')], 80 * 1024);
        // The build forks a child just before it is frozen.
        if (pid === 170 && signal === 'SIGSTOP' && !forked) {
          forked = true;
          fake(171, 170, [marker('hog')], 900 * 1024);
        }
      },
    });
    const result = await stopForMemory(d, decision);
    for (const pid of [103, 104, 105, 170, 171])
      expect(existsSync(join(proc, String(pid)))).toBe(false);
    expect(calls).toContain('SIGKILL 171');
    expect(calls).toContain('SIGKILL 105');
    expect(result?.notProven).toBe(0);
  });

  it('samples on while a stop waits its turn, leaving only that agent out', async () => {
    fake(161, 1, [marker('hog')], 3_800 * 1024);
    fake(201, 1, [marker('quiet')], 197 * 1024);
    let release: () => void = () => {};
    const queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    let box = 4.5 * GIB;
    const guard = new MemoryGuard({
      ...deps(),
      limits,
      watched: () => ['hog', 'quiet'],
      held: () => null,
      // A reconcile holds the queue: the stop waits behind it.
      run: async (task) => {
        await queued;
        return task();
      },
      onStopped: () => {},
      readBox: async () => ({ bytes: box, shmem: 0 }),
    });
    await guard.tick();
    expect(await guard.tick()).toMatchObject({ kind: 'stop', agentId: 'hog' });
    // Still waiting: the runaway is frozen, and the next sample is taken.
    await vi.waitFor(() => expect(calls).toContain('SIGSTOP 161'));
    fake(202, 1, [marker('quiet')], 2_500 * 1024);
    box = 5.6 * GIB;
    expect(await guard.tick()).toMatchObject({ kind: 'stop', agentId: 'quiet' });
    release();
    await guard.settled();
  });

  it('keeps watching while one agent is stopped, ends its leftovers once held, and still stops another', async () => {
    fake(103, 1, [marker('hog')], 117 * 1024);
    fake(161, 1, [marker('hog')], 3_800 * 1024);
    fake(201, 1, [marker('quiet')], 197 * 1024);
    const held = new Map<string, 'out_of_memory'>();
    const stopped: string[] = [];
    let box = 4.5 * GIB;
    const base = deps();
    const guard = new MemoryGuard({
      ...base,
      rest: {
        suspend: (agentId) => {
          held.set(agentId, 'out_of_memory');
          base.rest.suspend(agentId);
        },
        stopped: base.rest.stopped,
        clear: base.rest.clear,
      },
      limits,
      watched: () => ['hog', 'quiet'],
      held: (agentId) => held.get(agentId) ?? null,
      run: (task) => task(),
      onStopped: (decided) => stopped.push(decided.agentId),
      readBox: async () => ({ bytes: box, shmem: 4 * MIB }),
    });
    expect((await guard.tick()).kind).toBe('none');
    expect(await guard.tick()).toMatchObject({ kind: 'stop', agentId: 'hog', trigger: 'share' });
    await guard.settled();
    expect(stopped).toEqual(['hog']);
    // Something of the stopped agent is still there: ended on the next sample.
    fake(162, 1, [marker('hog')], 3_800 * 1024);
    expect((await guard.tick()).kind).toBe('none');
    expect(existsSync(join(proc, '162'))).toBe(false);
    // Straight after, another agent spikes past 92%: there is no blind window.
    fake(202, 1, [marker('quiet')], 2_500 * 1024);
    box = 5.6 * GIB;
    expect(await guard.tick()).toMatchObject({
      kind: 'stop',
      agentId: 'quiet',
      trigger: 'backstop',
    });
    await guard.settled();
    expect(stopped).toEqual(['hog', 'quiet']);
  });
});

describe('MemoryGuard with /dev/shm filled', () => {
  it('stops no one, logs once, and notes it for the report until the box falls back', async () => {
    const markers = new OwnerMarkers(Buffer.alloc(32, 5));
    const root = mkdtempSync(join(tmpdir(), 'memory-guard-shm-'));
    const proc = join(root, 'proc');
    mkdirSync(proc);
    const warnings: unknown[] = [];
    let box = { bytes: 5.0 * GIB, shmem: 3.5 * GIB };
    const guard = new MemoryGuard({
      markers,
      limits,
      rest: { suspend: () => {}, stopped: () => {}, clear: () => {} },
      stopHost: async () => {
        throw new Error('must not stop');
      },
      agentDir: (agentId) => join(root, agentId),
      log: {
        info: () => {},
        warn: (...args: unknown[]) => warnings.push(args),
        error: () => {},
        debug: () => {},
      } as never,
      now: () => 0,
      proc: { procRoot: proc, self: 7 },
      watched: () => ['a', 'b'],
      held: () => null,
      run: (task) => task(),
      onStopped: () => {
        throw new Error('must not stop');
      },
      readBox: async () => box,
    });
    try {
      expect((await guard.tick()).kind).toBe('none');
      box = { bytes: 5.7 * GIB, shmem: 4.2 * GIB };
      expect((await guard.tick()).kind).toBe('unexplained');
      box = { bytes: 5.8 * GIB, shmem: 4.3 * GIB };
      expect((await guard.tick()).kind).toBe('unexplained');
      expect(warnings).toHaveLength(1);
      // A fixed code and the figures, never text (status extras).
      expect(guard.boxNote()).toEqual({
        code: 'unexplained',
        boxBytes: Math.round(5.8 * GIB),
        shmemBytes: Math.round(4.3 * GIB),
      });
      box = { bytes: 5.6 * GIB, shmem: 4.1 * GIB }; // falling, still high: the note stays
      await guard.tick();
      expect(guard.boxNote()).not.toBeNull();
      box = { bytes: 3.0 * GIB, shmem: 1.5 * GIB };
      await guard.tick();
      expect(guard.boxNote()).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MemoryGuard noting a box that rises past 92%, then stays there', () => {
  it('logs the rising note once and then the slow-leak note once, as the live run sees it', async () => {
    const markers = new OwnerMarkers(Buffer.alloc(32, 8));
    const root = mkdtempSync(join(tmpdir(), 'memory-guard-notes-'));
    const proc = join(root, 'proc');
    mkdirSync(proc);
    const warnings: string[] = [];
    let clock = 0;
    let box = 5.0 * GIB;
    const guard = new MemoryGuard({
      markers,
      limits,
      rest: { suspend: () => {}, stopped: () => {}, clear: () => {} },
      stopHost: async () => {},
      agentDir: (agentId) => join(root, agentId),
      log: {
        info: () => {},
        warn: (message: string) => warnings.push(message),
        error: () => {},
        debug: () => {},
      } as never,
      now: () => clock,
      proc: { procRoot: proc, self: 7 },
      watched: () => ['a'],
      held: () => null,
      run: (task) => task(),
      onStopped: () => {},
      readBox: async () => ({ bytes: box, shmem: 0 }),
    });
    try {
      // Unmarked memory pushes the box past 92%, then it sits flat.
      for (const b of [5.0, 5.4, 5.7, 5.75, 5.75, 5.75, 5.75, 5.75]) {
        box = b * GIB;
        await guard.tick();
        clock += 2_000;
      }
      expect(warnings.filter((w) => w.startsWith('Box memory is high'))).toHaveLength(1);
      expect(warnings.filter((w) => w.startsWith('Box memory has stayed above'))).toHaveLength(1);
      // Back under the line: a later episode is said again.
      box = 4.0 * GIB;
      await guard.tick();
      for (const b of [5.7, 5.75, 5.75, 5.75, 5.75]) {
        box = b * GIB;
        clock += 2_000;
        await guard.tick();
      }
      expect(warnings.filter((w) => w.startsWith('Box memory has stayed above'))).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MemoryGuard while a stop is under way', () => {
  it('makes no slow-leak stop until it has finished, then counts the minute from then', async () => {
    const markers = new OwnerMarkers(Buffer.alloc(32, 7));
    const root = mkdtempSync(join(tmpdir(), 'memory-guard-pause-'));
    const proc = join(root, 'proc');
    mkdirSync(proc);
    const fakeProc = (pid: number, agentId: string, kib: number) => {
      const at = join(proc, String(pid));
      mkdirSync(at, { recursive: true });
      writeFileSync(join(at, 'status'), `Name:\tnode\nTgid:\t${pid}\nPid:\t${pid}\nPPid:\t1\n`);
      writeFileSync(
        join(at, 'stat'),
        `${pid} (node) S 1 ${pid} ${pid} 0 -1 4194560 812 0 0 0 3 1 0 0 20 0 1 0 ${1000 + pid} 1 \n`
      );
      writeFileSync(join(at, 'environ'), `SWITCH_OWNER_MARKER=${markers.markerFor(agentId)}\0`);
      writeFileSync(join(at, 'smaps'), `00-01 rw-p 00000000 00:00 0\nAnonymous: ${kib} kB\n`);
    };
    fakeProc(170, 'a', Math.round(4.0 * 1024 * 1024)); // over its share
    fakeProc(180, 'b', Math.round(1.8 * 1024 * 1024));
    let clock = 0;
    let release: () => void = () => {};
    const queued = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stopped: string[] = [];
    const guard = new MemoryGuard({
      markers,
      limits,
      rest: { suspend: () => {}, stopped: () => {}, clear: () => {} },
      stopHost: async () => {},
      agentDir: (agentId) => join(root, 'agents', agentId),
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      now: () => clock,
      proc: { procRoot: proc, self: 7 },
      kill: () => {},
      sleep: async () => {},
      watched: () => ['a', 'b'],
      held: () => null,
      // A reconcile holds the queue: a's stop waits behind it.
      run: async (task) => {
        await queued;
        return task();
      },
      onStopped: (decision) => stopped.push(decision.agentId),
      readBox: async () => ({ bytes: 5.6 * GIB, shmem: 0 }),
    });
    try {
      await guard.tick();
      clock += 2_000;
      expect(await guard.tick()).toMatchObject({ kind: 'stop', agentId: 'a', trigger: 'share' });
      // The box stays high for well over a minute while a's stop waits: b is not stopped.
      for (let i = 0; i < 40; i++) {
        clock += 2_000;
        expect((await guard.tick()).kind).not.toBe('stop');
      }
      rmSync(join(proc, '170'), { recursive: true });
      release();
      await guard.settled();
      expect(stopped).toEqual(['a']);
      // The minute starts when a's stop finished.
      const finished = clock;
      let decision: GuardDecision = { kind: 'none' };
      while (decision.kind !== 'stop' && clock - finished < 120_000) {
        clock += 2_000;
        decision = await guard.tick();
      }
      expect(decision).toMatchObject({ kind: 'stop', agentId: 'b', trigger: 'sustained' });
      expect(clock - finished).toBeGreaterThanOrEqual(60_000);
      await guard.settled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MemoryGuard and /proc files over the cap', () => {
  it('warns once for a process whose smaps is over the cap, with the agent and pid, tick after tick', async () => {
    const markers = new OwnerMarkers(Buffer.alloc(32, 9));
    const root = mkdtempSync(join(tmpdir(), 'memory-guard-cap-'));
    const proc = join(root, 'proc');
    const at = join(proc, '170');
    mkdirSync(at, { recursive: true });
    writeFileSync(
      join(at, 'status'),
      'Name:\tnode\nTgid:\t170\nPid:\t170\nPPid:\t1\nVmRSS:\t 1000 kB\n'
    );
    writeFileSync(
      join(at, 'stat'),
      '170 (node) S 1 170 170 0 -1 4194560 812 0 0 0 3 1 0 0 20 0 1 0 1170 1 \n'
    );
    writeFileSync(join(at, 'environ'), `SWITCH_OWNER_MARKER=${markers.markerFor('a')}\0`);
    writeFileSync(join(at, 'smaps'), '00-01 rw-p 00000000 00:00 0\nAnonymous: 4 kB\n'.repeat(50));
    const warned: unknown[][] = [];
    let clock = 0;
    const guard = new MemoryGuard({
      markers,
      limits,
      rest: { suspend: () => {}, stopped: () => {}, clear: () => {} },
      stopHost: async () => {},
      agentDir: (agentId) => join(root, 'agents', agentId),
      log: {
        info: () => {},
        warn: (...args: unknown[]) => warned.push(args),
        error: () => {},
        debug: () => {},
      } as never,
      now: () => clock,
      proc: { procRoot: proc, self: 7, smapsMax: 200 },
      kill: () => {},
      sleep: async () => {},
      watched: () => ['a'],
      held: () => null,
      run: async (task) => task(),
      readBox: async () => ({ bytes: 1 * GIB, shmem: 0 }),
      onStopped: () => {},
    });
    try {
      for (let i = 0; i < 3; i++) {
        await guard.tick();
        clock += 2_000;
      }
      expect(warned).toEqual([
        [
          'Memory guard measured a process from its status: its smaps is over the cap',
          { agentId: 'a', pid: 170 },
        ],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('MemoryGuard ticks slower than the interval', () => {
  it('logs once a run, with the duration and the pid of the largest read, and again after a fast tick', async () => {
    const markers = new OwnerMarkers(Buffer.alloc(32, 10));
    const root = mkdtempSync(join(tmpdir(), 'memory-guard-slow-'));
    const proc = join(root, 'proc');
    for (const [pid, maps] of [
      [170, 5],
      [171, 400],
    ] as const) {
      const at = join(proc, String(pid));
      mkdirSync(at, { recursive: true });
      writeFileSync(join(at, 'status'), `Name:\tnode\nTgid:\t${pid}\nPid:\t${pid}\nPPid:\t1\n`);
      writeFileSync(
        join(at, 'stat'),
        `${pid} (node) S 1 ${pid} ${pid} 0 -1 4194560 812 0 0 0 3 1 0 0 20 0 1 0 1${pid} 1 \n`
      );
      writeFileSync(join(at, 'environ'), `SWITCH_OWNER_MARKER=${markers.markerFor('a')}\0`);
      writeFileSync(
        join(at, 'smaps'),
        '00-01 rw-p 00000000 00:00 0\nAnonymous: 4 kB\n'.repeat(maps)
      );
    }
    const warned: unknown[][] = [];
    const durations = [3_100, 2_500, 2_600, 400, 5_000];
    let tickMs = 0;
    let readings = 0;
    const guard = new MemoryGuard({
      markers,
      limits,
      rest: { suspend: () => {}, stopped: () => {}, clear: () => {} },
      stopHost: async () => {},
      agentDir: (agentId) => join(root, 'agents', agentId),
      log: {
        info: () => {},
        warn: (...args: unknown[]) => warned.push(args),
        error: () => {},
        debug: () => {},
      } as never,
      now: () => 0,
      // Each tick reads the clock twice: at its start, then at its end.
      elapsed: () => (readings++ % 2 === 0 ? 0 : tickMs),
      proc: { procRoot: proc, self: 7 },
      kill: () => {},
      sleep: async () => {},
      watched: () => ['a'],
      held: () => null,
      run: async (task) => task(),
      readBox: async () => ({ bytes: 1 * GIB, shmem: 0 }),
      onStopped: () => {},
    });
    try {
      for (const ms of durations) {
        tickMs = ms;
        await guard.tick();
      }
      const slow = { durationMs: 3_100, pid: 171 };
      expect(warned).toEqual([
        ['Memory guard sample took longer than its interval', slow],
        ['Memory guard sample took longer than its interval', { durationMs: 5_000, pid: 171 }],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('GuardJudge while the box valve sheds', () => {
  const flat = { leaky: 2.2 * GIB, quiet: IDLE_AGENT };
  /** 60 s above the line plus the most the valve may hold it, on the next 2 s sample. */
  const LATEST = Math.ceil((60_000 + SHED_PAUSE_MAX_MS) / 2_000) * 2;
  /** The box flat just past 92%, a sample every 2 s from `from`; the time of the first stop, or null. */
  function firstStop(
    judge: GuardJudge,
    from: number,
    to: number,
    before?: (s: number) => void
  ): { s: number; decision: GuardDecision } | null {
    for (let s = from; s <= to; s += 2) {
      before?.(s);
      const decision = judge.judge({
        box: 5.6 * GIB,
        agents: new Map(Object.entries(flat)),
        at: s * 1000,
      });
      if (decision.kind === 'stop') return { s, decision };
    }
    return null;
  }

  it('holds the slow-leak clock for at most 75 s an episode, even if the valve never says it has finished', () => {
    const judge = new GuardJudge(limits);
    judge.setShedding(true);
    const stop = firstStop(judge, 0, 300);
    // 60 s above the line plus the 75 s it may hold, and no more.
    expect(stop).toMatchObject({
      s: LATEST,
      decision: { trigger: 'sustained', agentId: 'leaky' },
    });
    expect(judge.takePauseSpent()).toBe(true);
    expect(judge.takePauseSpent()).toBe(false);
  });

  it('holds it only as long as a short shed lasts', () => {
    const judge = new GuardJudge(limits);
    judge.setShedding(true);
    const stop = firstStop(judge, 0, 300, (s) => {
      if (s === 20) judge.setShedding(false);
    });
    expect(stop?.s).toBe(78);
    expect(judge.takePauseSpent()).toBe(false);
  });

  it('cannot hold it longer than 75 s in 5 minutes through sheds one after another', () => {
    const judge = new GuardJudge(limits);
    judge.setShedding(true);
    const stop = firstStop(judge, 0, 300, (s) => {
      // The valve finishes and starts again every 30 s: each start is a new episode.
      if (s > 0 && s % 30 === 0) judge.setShedding(false);
      if (s > 0 && s % 30 === 2) judge.setShedding(true);
    });
    expect(stop).not.toBeNull();
    expect(stop!.s).toBeLessThanOrEqual(LATEST);
  });

  it('may hold it again once the last pause is 5 minutes old', () => {
    const judge = new GuardJudge(limits);
    judge.setShedding(true);
    expect(firstStop(judge, 0, 300)?.s).toBe(LATEST);
    judge.setShedding(false);
    // The box falls back under the line, then a new leak and a new shed come 6 minutes later.
    judge.judge({ box: 4 * GIB, agents: new Map([['quiet', IDLE_AGENT]]), at: 200_000 });
    judge.setShedding(true);
    expect(firstStop(judge, 500, 900)?.s).toBe(500 + LATEST);
  });

  it('never holds the share rule: an agent over its share is stopped while the valve sheds', () => {
    const judge = new GuardJudge(limits);
    judge.setShedding(true);
    const agents = new Map([['runaway', 4 * GIB]]);
    expect(judge.judge({ box: 4.5 * GIB, agents, at: 0 }).kind).toBe('none');
    expect(judge.judge({ box: 4.5 * GIB, agents, at: 2_000 })).toMatchObject({
      kind: 'stop',
      agentId: 'runaway',
      trigger: 'share',
    });
  });

  it('never holds the backstop: a box past 92% and rising is still stopped at once', () => {
    const judge = new GuardJudge(limits);
    judge.setShedding(true);
    judge.judge({
      box: 5.0 * GIB,
      agents: new Map([
        ['hog', 1.6 * GIB],
        ['quiet', IDLE_AGENT],
      ]),
      at: 0,
    });
    expect(
      judge.judge({
        box: 5.7 * GIB,
        agents: new Map([
          ['hog', 2.3 * GIB],
          ['quiet', IDLE_AGENT],
        ]),
        at: 2_000,
      })
    ).toMatchObject({ kind: 'stop', agentId: 'hog', trigger: 'backstop' });
  });
});

describe('MemoryGuard with the box flat above 92%', () => {
  it('sets the box note after 3 samples, logs once, and stops the largest agent after a minute', async () => {
    const markers = new OwnerMarkers(Buffer.alloc(32, 6));
    const root = mkdtempSync(join(tmpdir(), 'memory-guard-flat-'));
    const proc = join(root, 'proc');
    mkdirSync(proc);
    const at = join(proc, '170');
    mkdirSync(at);
    writeFileSync(join(at, 'status'), 'Name:\tnode\nTgid:\t170\nPid:\t170\nPPid:\t1\n');
    writeFileSync(
      join(at, 'stat'),
      '170 (node) S 1 170 170 0 -1 4194560 812 0 0 0 3 1 0 0 20 0 1 0 1170 1 \n'
    );
    writeFileSync(join(at, 'environ'), `SWITCH_OWNER_MARKER=${markers.markerFor('leaky')}\0`);
    writeFileSync(
      join(at, 'smaps'),
      `00-01 rw-p 00000000 00:00 0\nAnonymous: ${Math.round(2.2 * 1024 * 1024)} kB\n`
    );
    const warnings: unknown[] = [];
    const stopped: string[] = [];
    let clock = 0;
    const guard = new MemoryGuard({
      markers,
      limits,
      rest: { suspend: () => {}, stopped: () => {}, clear: () => {} },
      stopHost: async () => {},
      agentDir: (agentId) => join(root, 'agents', agentId),
      log: {
        info: () => {},
        warn: (...args: unknown[]) => warnings.push(args),
        error: () => {},
        debug: () => {},
      } as never,
      now: () => clock,
      proc: { procRoot: proc, self: 7 },
      kill: () => {},
      sleep: async (ms) => {
        clock += ms;
      },
      watched: () => ['leaky'],
      held: () => null,
      run: (task) => task(),
      onStopped: (decision) => stopped.push(decision.agentId),
      readBox: async () => ({ bytes: 5.6 * GIB, shmem: 0 }),
    });
    try {
      for (let i = 0; i < 2; i++) {
        await guard.tick();
        clock += 2_000;
      }
      expect(guard.boxNote()).toBeNull();
      await guard.tick();
      expect(guard.boxNote()).toEqual({
        code: 'sustained',
        boxBytes: Math.round(5.6 * GIB),
        shmemBytes: 0,
      });
      for (let i = 0; i < 30 && stopped.length === 0; i++) {
        clock += 2_000;
        await guard.tick();
        await guard.settled();
      }
      expect(stopped).toEqual(['leaky']);
      expect(JSON.stringify(warnings).match(/stayed above the backstop/g)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('holds its slow-leak clock while the box valve sheds, within the limit, and says once when it runs again', async () => {
    const markers = new OwnerMarkers(Buffer.alloc(32, 11));
    const root = mkdtempSync(join(tmpdir(), 'memory-guard-shed-'));
    const proc = join(root, 'proc');
    const at = join(proc, '170');
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, 'status'), 'Name:\tnode\nTgid:\t170\nPid:\t170\nPPid:\t1\n');
    writeFileSync(
      join(at, 'stat'),
      '170 (node) S 1 170 170 0 -1 4194560 812 0 0 0 3 1 0 0 20 0 1 0 1170 1 \n'
    );
    writeFileSync(join(at, 'environ'), `SWITCH_OWNER_MARKER=${markers.markerFor('leaky')}\0`);
    writeFileSync(
      join(at, 'smaps'),
      `00-01 rw-p 00000000 00:00 0\nAnonymous: ${Math.round(2.2 * 1024 * 1024)} kB\n`
    );
    const infos: unknown[][] = [];
    const stopped: { agentId: string; at: number }[] = [];
    let clock = 0;
    const guard = new MemoryGuard({
      markers,
      limits,
      rest: { suspend: () => {}, stopped: () => {}, clear: () => {} },
      stopHost: async () => {},
      agentDir: (agentId) => join(root, 'agents', agentId),
      log: {
        info: (...args: unknown[]) => infos.push(args),
        warn: () => {},
        error: () => {},
        debug: () => {},
      } as never,
      now: () => clock,
      proc: { procRoot: proc, self: 7 },
      kill: () => {},
      sleep: async () => {},
      watched: () => ['leaky'],
      held: () => null,
      run: (task) => task(),
      onStopped: (decision) => stopped.push({ agentId: decision.agentId, at: clock }),
      readBox: async () => ({ bytes: 5.6 * GIB, shmem: 0 }),
    });
    try {
      guard.valveShedding(true);
      for (let i = 0; i < 100 && stopped.length === 0; i++) {
        await guard.tick();
        await guard.settled();
        clock += 2_000;
      }
      // Not at 60 s: the valve held the clock, for 75 s at most.
      expect(stopped).toEqual([{ agentId: 'leaky', at: 136_000 }]);
      expect(infos.filter((args) => String(args[0]).includes('shedding pause limit'))).toHaveLength(
        1
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('hostAnnouncer', () => {
  it('writes the request in the state root before it asks the host, so the host will post', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-guard-announce-'));
    try {
      const seen: boolean[] = [];
      const runtime = {
        stopForMemory: async (agentId: string) => {
          seen.push(existsSync(join(root, agentId, 'memory-stop.json')));
          return 1;
        },
      };
      mkdirSync(join(root, 'agent-1'));
      const announce = hostAnnouncer(runtime, (agentId) => join(root, agentId));
      expect(await announce!('agent-1')).toBe(1);
      expect(seen).toEqual([true]);
      // A runtime with no way to ask the host gives no announcer.
      expect(hostAnnouncer({}, (agentId) => join(root, agentId))).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('readBoxMemory', () => {
  let proc: string;
  beforeEach(() => {
    proc = mkdtempSync(join(tmpdir(), 'memory-guard-box-'));
  });
  afterEach(() => rmSync(proc, { recursive: true, force: true }));

  it('counts Shmem with AnonPages, and takes the cgroup reading when it is higher', async () => {
    writeFileSync(
      join(proc, 'meminfo'),
      'MemTotal:        6291456 kB\nAnonPages:       1058816 kB\nShmem:           2097152 kB\n'
    );
    expect(await readBoxMemory({ procRoot: proc, cgroupUsage: async () => null })).toEqual({
      bytes: (1058816 + 2097152) * 1024,
      shmem: 2097152 * 1024,
      source: 'meminfo',
    });
    expect(await readBoxMemory({ procRoot: proc, cgroupUsage: async () => 5 * GIB })).toEqual({
      bytes: 5 * GIB,
      shmem: 2097152 * 1024,
      source: 'cgroup',
    });
    rmSync(join(proc, 'meminfo'));
    expect(await readBoxMemory({ procRoot: proc, cgroupUsage: async () => null })).toBeNull();
    expect(await readBoxMemory({ procRoot: proc, cgroupUsage: async () => GIB })).toEqual({
      bytes: GIB,
      shmem: null,
      source: 'cgroup',
    });
  });

  it('falls back to MemTotal − MemAvailable when AnonPages or Shmem is missing (gVisor)', async () => {
    writeFileSync(
      join(proc, 'meminfo'),
      'MemTotal:        1310720 kB\nMemFree:          100000 kB\nMemAvailable:     139264 kB\n'
    );
    const used = (1310720 - 139264) * 1024;
    // A split box passes no cgroup: the pod's total comes from meminfo alone.
    expect(await readBoxMemory({ procRoot: proc, cgroupUsage: async () => null })).toEqual({
      bytes: used,
      shmem: null,
      source: 'meminfo_used',
    });
    // The cgroup still wins where it reads higher (a box without the split).
    expect(await readBoxMemory({ procRoot: proc, cgroupUsage: async () => 2 * GIB })).toEqual({
      bytes: 2 * GIB,
      shmem: null,
      source: 'cgroup',
    });
    expect(usedFromMeminfo('MemTotal:        1310720 kB\n')).toBeNull();
  });
});

describe('GuardStatus', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memory-guard-status-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('shows the detail only while the agent is held, and keeps the count across a restart', async () => {
    let held = true;
    const agentDir = (agentId: string) => join(root, agentId);
    mkdirSync(agentDir('hog'));
    writeFileSync(
      join(agentDir('hog'), 'guard-stop.json'),
      JSON.stringify({
        count: 2,
        held: true,
        last: {
          at: '2026-10-27T13:00:00Z',
          bytes: Math.round(3.9 * GIB),
          limit: Math.floor(BOX * 0.6),
          percent: 60,
          trigger: 'share',
        },
      })
    );
    // A controller started after the stop reads the record from disk.
    const status = new GuardStatus({ agentDir, stillHeld: () => held });
    await status.load('hog');
    await status.load('quiet');
    expect(status.oomKills('hog')).toBe(2);
    expect(status.oomKills('quiet')).toBe(0);
    expect(status.held('hog')).toBe(
      'Stopped by the memory guard at 3.9 GiB (its limit is 3.6 GiB).'
    );
    expect(status.held('quiet')).toBeNull();
    held = false; // its next message woke it
    expect(status.held('hog')).toBeNull();
    expect(status.oomKills('hog')).toBe(2);
  });
});

describe('the guard stops since start', () => {
  it('counts each stop it is told of, not records read back from disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-guard-stops-'));
    try {
      const agentDir = (agentId: string) => join(root, agentId);
      mkdirSync(agentDir('old'));
      writeFileSync(
        join(agentDir('old'), 'guard-stop.json'),
        JSON.stringify({
          count: 4,
          held: false,
          last: {
            at: '2026-10-27T13:00:00Z',
            bytes: 4 * GIB,
            limit: Math.floor(BOX * 0.6),
            percent: 60,
            trigger: 'share',
          },
        })
      );
      const status = new GuardStatus({ agentDir, stillHeld: () => false });
      await status.load('old');
      // A stop from before this start is the agent's history, not this run's.
      expect(status.stops()).toBe(0);
      const record = {
        count: 1,
        held: true,
        last: {
          at: '2026-10-29T10:00:00Z',
          bytes: 4 * GIB,
          limit: Math.floor(BOX * 0.6),
          percent: 60,
          trigger: 'share' as const,
        },
      };
      status.remember('hog', record);
      status.remember('hog', { ...record, count: 2 });
      status.remember('other', record);
      expect(status.stops()).toBe(3);
      expect(status.oomKills('old')).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the guard-stop record after a restart', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memory-guard-restore-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = (agentId: string) => join(root, agentId);
  const record = (held: boolean) =>
    JSON.stringify({
      count: 1,
      held,
      last: {
        at: '2026-10-27T13:00:00Z',
        bytes: 4 * GIB,
        limit: Math.floor(BOX * 0.6),
        percent: 60,
        trigger: 'share',
      },
    });

  it('holds again an agent its next message has not woken, and releases it once woken', async () => {
    mkdirSync(agentDir('hog'));
    writeFileSync(join(agentDir('hog'), 'guard-stop.json'), record(true));
    mkdirSync(agentDir('woken'));
    writeFileSync(join(agentDir('woken'), 'guard-stop.json'), record(false));
    const calls: string[] = [];
    let held = new Set<string>();
    const rest = {
      suspend: (id: string) => {
        held.add(id);
        calls.push(`suspend ${id}`);
      },
      stopped: (id: string) => void calls.push(`stopped ${id}`),
      clear: (id: string) => void calls.push(`clear ${id}`),
    };
    const status = new GuardStatus({ agentDir, stillHeld: (id) => held.has(id) });
    mkdirSync(agentDir('parked-by-owner'));
    writeFileSync(join(agentDir('parked-by-owner'), 'guard-stop.json'), record(true));
    const log = { error: () => {} };
    expect(await status.restore(['hog', 'woken', 'never'], rest, log, ['parked-by-owner'])).toEqual(
      ['hog']
    );
    // Its owner stopped it: not held again, and not held on disk any more.
    expect((await readGuardStop(agentDir('parked-by-owner')))?.held).toBe(false);
    expect(calls).toEqual(['suspend hog', 'stopped hog']);
    expect(status.held('hog')).not.toBeNull();
    held = new Set(); // its message came, and the wake releases it at once
    await status.release('hog', log);
    expect((await readGuardStop(agentDir('hog')))?.held).toBe(false);
    expect(status.oomKills('hog')).toBe(1);
  });

  it('does not let a late release from one wake undo a newer stop', async () => {
    mkdirSync(agentDir('hog'));
    writeFileSync(join(agentDir('hog'), 'guard-stop.json'), record(true));
    const status = new GuardStatus({ agentDir, stillHeld: () => false });
    await status.load('hog');
    // Stopped again before the first wake's release lands.
    writeFileSync(
      join(agentDir('hog'), 'guard-stop.json'),
      record(true).replace('"count":1', '"count":2').replace('13:00:00Z', '13:00:30Z')
    );
    await status.release('hog', { error: () => {} });
    expect(await readGuardStop(agentDir('hog'))).toMatchObject({ count: 2, held: true });
  });

  it('takes nothing from a record that is a link, too large, or out of range', async () => {
    mkdirSync(agentDir('a'));
    writeFileSync(join(root, 'elsewhere.json'), record(true));
    symlinkSync(join(root, 'elsewhere.json'), join(agentDir('a'), 'guard-stop.json'));
    expect(await readGuardStop(agentDir('a'))).toBeNull();
    mkdirSync(agentDir('b'));
    writeFileSync(join(agentDir('b'), 'guard-stop.json'), ' '.repeat(5000) + record(true));
    expect(await readGuardStop(agentDir('b'))).toBeNull();
    mkdirSync(agentDir('c'));
    writeFileSync(
      join(agentDir('c'), 'guard-stop.json'),
      record(true).replace('"percent":60', '"percent":"60 (and a message to the owner)"')
    );
    expect(await readGuardStop(agentDir('c'))).toBeNull();
    mkdirSync(agentDir('d'));
    writeFileSync(
      join(agentDir('d'), 'guard-stop.json'),
      record(true).replace('"count":1', '"count":-5')
    );
    expect(await readGuardStop(agentDir('d'))).toBeNull();
  });
});

describe('guardLimitsFromEnv', () => {
  const log = { warn: () => {} };
  it('is off without a box limit, so a laptop never runs it', () => {
    expect(guardLimitsFromEnv({}, log)).toBeNull();
  });
  it('takes the box limit and a share, refusing a share out of bounds', () => {
    const env = { SWITCH_BOX_MEMORY_LIMIT_BYTES: String(BOX) };
    expect(guardLimitsFromEnv(env, log)).toEqual({
      ...DEFAULT_LIMITS,
      boxLimit: BOX,
      podLimit: BOX,
      reserve: 0,
    });
    expect(guardLimitsFromEnv({ ...env, SWITCH_AGENT_MEMORY_SHARE: '0.5' }, log)?.share).toBe(0.5);
    expect(guardLimitsFromEnv({ ...env, SWITCH_AGENT_MEMORY_SHARE: '1.5' }, log)?.share).toBe(0.6);
    expect(guardLimitsFromEnv({ ...env, SWITCH_AGENT_MEMORY_SHARE: 'lots' }, log)?.share).toBe(0.6);
  });
  it('works to the box limit less the controller reserve, keeping the box limit for the log', () => {
    const env = { SWITCH_BOX_MEMORY_LIMIT_BYTES: String(BOX) };
    const reserve = 256 * 1024 * 1024;
    const limits = guardLimitsFromEnv(env, log, reserve);
    expect(limits?.boxLimit).toBe(BOX - reserve);
    expect(limits?.podLimit).toBe(BOX);
    expect(limits?.reserve).toBe(reserve);
    // The share and the backstop are fractions of the lower line.
    expect(limits?.share).toBe(DEFAULT_LIMITS.share);
  });
  it('stays off for a box limit too small to be bytes', () => {
    const warned: unknown[] = [];
    expect(
      guardLimitsFromEnv(
        { SWITCH_BOX_MEMORY_LIMIT_BYTES: '6144' },
        { warn: (...a: unknown[]) => warned.push(a) }
      )
    ).toBeNull();
    expect(warned).toHaveLength(1);
  });
});

describe('MemoryGuard through the launcher', () => {
  function remoteGuard(read: () => Map<string, { undisputed: number; processes: number }> | null) {
    const root = mkdtempSync(join(tmpdir(), 'memory-guard-remote-'));
    const calls: string[] = [];
    const stopped: string[] = [];
    let clock = 0;
    const guard = new MemoryGuard({
      markers: new OwnerMarkers(Buffer.alloc(32, 12)),
      limits,
      rest: { suspend: () => {}, stopped: () => {}, clear: () => {} },
      stopHost: async (agentId) => void calls.push(`stopHost ${agentId}`),
      agentDir: (agentId) => join(root, 'guard', agentId),
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      now: () => clock,
      // No /proc to read: everything must come through the launcher.
      proc: { procRoot: join(root, 'no-proc'), self: 7 },
      sleep: async () => {},
      watched: () => ['a', 'b'],
      held: () => null,
      run: (task) => task(),
      onStopped: (decision) => void stopped.push(decision.agentId),
      readBox: async () => ({ bytes: 4.5 * GIB, shmem: 0 }),
      remote: {
        read,
        freeze: async (agentId) => void calls.push(`freeze ${agentId}`),
        thaw: async (agentId) => void calls.push(`thaw ${agentId}`),
        end: async (agentId) => {
          calls.push(`end ${agentId}`);
          return { forced: 3, notProven: 0, left: 0 };
        },
      },
    });
    return { guard, calls, stopped, root, advance: () => (clock += 2_000) };
  }

  it("stops an agent over its share from the launcher's figures: freeze, ask the host, end in rounds", async () => {
    const { guard, calls, stopped, root, advance } = remoteGuard(
      () =>
        new Map([
          ['a', { undisputed: 4 * GIB, processes: 5 }],
          ['b', { undisputed: IDLE_AGENT, processes: 2 }],
        ])
    );
    try {
      await guard.tick();
      advance();
      expect(await guard.tick()).toMatchObject({ kind: 'stop', agentId: 'a', trigger: 'share' });
      await guard.settled();
      expect(calls).toEqual(['freeze a', 'stopHost a', 'end a']);
      expect(stopped).toEqual(['a']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('with no fresh figures from the launcher, blames no agent: the box is judged alone', async () => {
    const { guard, calls, root, advance } = remoteGuard(() => null);
    try {
      for (let i = 0; i < 3; i++) {
        expect((await guard.tick()).kind).not.toBe('stop');
        advance();
      }
      expect(calls).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
