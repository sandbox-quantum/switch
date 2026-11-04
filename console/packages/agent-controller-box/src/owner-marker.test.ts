import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listProcesses,
  MarkerTable,
  markerIn,
  openOwnerMarkers,
  OwnerMarkers,
  parseStat,
  PROC_FILE_MAX,
  ProcReader,
  processesOf,
  signalProven,
} from './owner-marker';

const markers = new OwnerMarkers(Buffer.alloc(32, 1));
const A = 'agent-a';
const B = 'agent-b';

let dir: string;
let proc: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'owner-marker-'));
  proc = join(dir, 'proc');
  mkdirSync(proc);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A `/proc/<pid>/stat` line as Linux writes it, with the fields after the start time cut. */
function statLine(pid: number, comm: string, ppid: number, startTicks: number): string {
  // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt
  // cmajflt utime stime cutime cstime priority nice threads itreal starttime vsize
  return `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194560 812 0 0 0 3 1 0 0 20 0 1 0 ${startTicks} 12345678 \n`;
}

/** Writes one process into the fake `/proc`. */
function fakeProcess(input: {
  pid: number;
  comm: string;
  ppid: number;
  startTicks: number;
  env: string[];
  tgid?: number;
}): void {
  const at = join(proc, String(input.pid));
  mkdirSync(at, { recursive: true });
  writeFileSync(
    join(at, 'status'),
    `Name:\t${input.comm}\nState:\tS (sleeping)\nTgid:\t${input.tgid ?? input.pid}\nPid:\t${input.pid}\nPPid:\t${input.ppid}\n`
  );
  writeFileSync(join(at, 'stat'), statLine(input.pid, input.comm, input.ppid, input.startTicks));
  writeFileSync(join(at, 'environ'), input.env.map((entry) => `${entry}\0`).join(''));
}

function reparent(pid: number, comm: string, ppid: number, startTicks: number): void {
  writeFileSync(join(proc, String(pid), 'stat'), statLine(pid, comm, ppid, startTicks));
}

const marked = (agentId: string) => `SWITCH_OWNER_MARKER=${markers.markerFor(agentId)}`;
const BASE = ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/data/home', 'LANG=C.UTF-8'];

/**
 * A box's process table, shaped as box A's on 27 Oct: tini as pid 1, the
 * controller, and for each agent a detached supervisor (reparented to tini
 * once its launcher exits) with its worker and the Claude CLI under it.
 */
function boxA(): void {
  fakeProcess({ pid: 1, comm: 'tini', ppid: 0, startTicks: 100, env: BASE });
  fakeProcess({ pid: 7, comm: 'node', ppid: 1, startTicks: 180, env: BASE });
  fakeProcess({ pid: 101, comm: 'node', ppid: 1, startTicks: 950, env: [...BASE, marked(A)] });
  fakeProcess({ pid: 102, comm: 'node', ppid: 101, startTicks: 990, env: [...BASE, marked(A)] });
  fakeProcess({ pid: 150, comm: 'claude', ppid: 102, startTicks: 4100, env: [...BASE, marked(A)] });
  fakeProcess({ pid: 201, comm: 'node', ppid: 1, startTicks: 960, env: [...BASE, marked(B)] });
  fakeProcess({ pid: 202, comm: 'node', ppid: 201, startTicks: 1000, env: [...BASE, marked(B)] });
}

describe('OwnerMarkers', () => {
  it('derives a different marker for each agent, and the same one each time', () => {
    expect(markers.markerFor(A)).toMatch(/^[0-9a-f]{64}$/);
    expect(markers.markerFor(A)).toBe(new OwnerMarkers(Buffer.alloc(32, 1)).markerFor(A));
    expect(markers.markerFor(A)).not.toBe(markers.markerFor(B));
    expect(new OwnerMarkers(Buffer.alloc(32, 2)).markerFor(A)).not.toBe(markers.markerFor(A));
    expect(markers.environmentFor(A)).toEqual({ SWITCH_OWNER_MARKER: markers.markerFor(A) });
  });

  it('names the agent a marker proves, and none for a guess, an id or another key', () => {
    expect(markers.ownerOf(markers.markerFor(B), [A, B])).toBe(B);
    expect(markers.ownerOf(markers.markerFor(B), [A])).toBeNull();
    expect(markers.ownerOf(A, [A, B])).toBeNull();
    expect(markers.ownerOf('', [A])).toBeNull();
    expect(markers.ownerOf(new OwnerMarkers(Buffer.alloc(32, 9)).markerFor(A), [A])).toBeNull();
  });

  it('keeps its key owner-only in the data directory, and the same across restarts', async () => {
    const first = await openOwnerMarkers(dir);
    const path = join(dir, 'owner-marker.key');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = await openOwnerMarkers(dir);
    expect(again.markerFor(A)).toBe(first.markerFor(A));
    expect(readFileSync(path, 'utf8')).not.toContain(first.markerFor(A));
  });

  it('makes one key when two starts race to make it, and leaves no temporary file', async () => {
    // Repeated: one start's sweep used to remove the other's key file mid-write, now and then.
    for (let round = 0; round < 30; round++) {
      const at = join(dir, `race-${round}`);
      mkdirSync(at);
      const [one, two] = await Promise.all([openOwnerMarkers(at), openOwnerMarkers(at)]);
      expect(one.markerFor(A)).toBe(two.markerFor(A));
      expect(readdirSync(at).filter((name) => name.startsWith('owner-marker'))).toEqual([
        'owner-marker.key',
      ]);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'tightens a key left readable by others, and says so',
    async () => {
      await openOwnerMarkers(dir);
      const path = join(dir, 'owner-marker.key');
      chmodSync(path, 0o644);
      const warned: unknown[] = [];
      await openOwnerMarkers(dir, { warn: (...args: unknown[]) => warned.push(args) });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(warned).toHaveLength(1);
    }
  );

  it("removes temporary key files a cut-off start left behind, never another start's fresh one", async () => {
    const left = join(dir, 'owner-marker.key.0b7c9a1e-left');
    writeFileSync(left, 'half a key');
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(left, old, old);
    writeFileSync(join(dir, 'owner-marker.key.5d2e-writing'), 'being written'); // another start, now
    await openOwnerMarkers(dir);
    expect(
      readdirSync(dir)
        .filter((name) => name.startsWith('owner-marker'))
        .sort()
    ).toEqual(['owner-marker.key', 'owner-marker.key.5d2e-writing']);
  });

  it('refuses a damaged key rather than replacing it', async () => {
    writeFileSync(join(dir, 'owner-marker.key'), 'not a key\n');
    await expect(openOwnerMarkers(dir)).rejects.toThrow(/not 32 bytes/);
    expect(readFileSync(join(dir, 'owner-marker.key'), 'utf8')).toBe('not a key\n');
  });
});

describe('parseStat', () => {
  it('reads the parent and start time, even from a command name with spaces and parentheses', () => {
    expect(parseStat(statLine(160, 'python3', 1, 5200))).toEqual({ ppid: 1, startTicks: 5200 });
    expect(parseStat(statLine(161, 'a) b (c', 150, 5300))).toEqual({ ppid: 150, startTicks: 5300 });
  });

  it('gives null for anything that is not a stat line', () => {
    expect(parseStat('')).toBeNull();
    expect(parseStat('12 (short) S 1')).toBeNull();
  });
});

describe('markerIn', () => {
  it('finds the marker among the entries, and nothing in an entry merely containing it', () => {
    const env = (entries: string[]) => Buffer.from(entries.map((e) => `${e}\0`).join(''));
    expect(markerIn(env([...BASE, 'SWITCH_OWNER_MARKER=abc']))).toBe('abc');
    expect(markerIn(env(BASE))).toBeNull();
    expect(markerIn(env(['X_SWITCH_OWNER_MARKER=abc', 'NOTE=SWITCH_OWNER_MARKER=abc']))).toBeNull();
    expect(markerIn(Buffer.alloc(0))).toBeNull();
    // No trailing NUL, as a block truncated by the reader may end.
    expect(markerIn(Buffer.from('A=1\0SWITCH_OWNER_MARKER=abc'))).toBe('abc');
  });

  it('takes a marker set twice to the same value, and proves nothing when the values differ', () => {
    const env = (entries: string[]) => Buffer.from(entries.map((e) => `${e}\0`).join(''));
    expect(markerIn(env(['SWITCH_OWNER_MARKER=abc', 'SWITCH_OWNER_MARKER=abc']))).toBe('abc');
    expect(markerIn(env(['SWITCH_OWNER_MARKER=abc', 'SWITCH_OWNER_MARKER=xyz']))).toBeNull();
  });
});

describe('ProcReader', () => {
  it('reads a file whole when it outgrows the buffer, and a shorter one after it exactly', async () => {
    const long = Buffer.from(Array.from({ length: 5_000 }, (_, i) => `line ${i}\n`).join(''));
    writeFileSync(join(dir, 'long'), long);
    writeFileSync(join(dir, 'short'), 'Tgid:\t9\n');
    writeFileSync(join(dir, 'empty'), '');
    const reader = new ProcReader(16);
    expect((await reader.read(join(dir, 'long'))).equals(long)).toBe(true);
    expect(await reader.text(join(dir, 'short'))).toBe('Tgid:\t9\n');
    expect((await reader.read(join(dir, 'empty'))).length).toBe(0);
    expect(await reader.text(join(dir, 'long'))).toBe(long.toString('utf8'));
  });

  it('reads a file of exactly the cap, and refuses one byte more without reading on', async () => {
    writeFileSync(join(dir, 'at-cap'), 'x'.repeat(100));
    writeFileSync(join(dir, 'over-cap'), 'x'.repeat(101));
    const reader = new ProcReader(16);
    expect((await reader.read(join(dir, 'at-cap'), 100)).length).toBe(100);
    await expect(reader.read(join(dir, 'over-cap'), 100)).rejects.toMatchObject({ code: 'EFBIG' });
    expect(reader.size).toBeLessThanOrEqual(101);
    expect(await reader.text(join(dir, 'at-cap'), 100)).toBe('x'.repeat(100));
  });

  it('gives every line once, across chunk edges, a line longer than the buffer, and no final newline', async () => {
    const lines = [
      ...Array.from({ length: 300 }, (_, i) => `Anonymous:     ${i} kB`),
      'z'.repeat(70),
      '',
      'last line, no newline',
    ];
    writeFileSync(join(dir, 'lines'), lines.join('\n'));
    writeFileSync(join(dir, 'empty'), '');
    const reader = new ProcReader(16);
    const seen: string[] = [];
    await reader.eachLine(join(dir, 'lines'), (line) => seen.push(line));
    expect(seen).toEqual(lines);
    const none: string[] = [];
    await reader.eachLine(join(dir, 'empty'), (line) => none.push(line));
    expect(none).toEqual([]);
  });

  it('goes back to its starting size after a read that grew it past 1 MiB, and only then', async () => {
    writeFileSync(join(dir, 'big'), Buffer.alloc(2 * 1024 * 1024, 0x41));
    writeFileSync(join(dir, 'mid'), Buffer.alloc(300 * 1024, 0x41));
    const reader = new ProcReader(64 * 1024);
    await reader.read(join(dir, 'mid'));
    reader.settle();
    expect(reader.size).toBe(512 * 1024);
    await reader.read(join(dir, 'big'));
    expect(reader.size).toBeGreaterThan(1024 * 1024);
    reader.settle();
    expect(reader.size).toBe(64 * 1024);
    expect((await reader.read(join(dir, 'big'))).length).toBe(2 * 1024 * 1024);
  });

  it('names the pid of the largest file read since it last settled', async () => {
    for (const [pid, size] of [
      [11, 10],
      [12, 300],
      [13, 50],
    ] as const) {
      mkdirSync(join(dir, String(pid)));
      writeFileSync(join(dir, String(pid), 'smaps'), 'x\n'.repeat(size));
    }
    const reader = new ProcReader(16);
    expect(reader.largestPid).toBe(null);
    for (const pid of [11, 12, 13])
      await reader.eachLine(join(dir, String(pid), 'smaps'), () => {});
    expect(reader.largestPid).toBe(12);
    reader.settle();
    expect(reader.largestPid).toBe(null);
    await reader.read(join(dir, '13', 'smaps'));
    expect(reader.largestPid).toBe(13);
  });

  it('fails as readFile did for a file that is not there, so a vanished process is skipped', async () => {
    await expect(new ProcReader().read(join(dir, 'gone'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reads a real /proc file whose size reads as 0, where there is one', async () => {
    let real: string;
    try {
      real = readFileSync('/proc/self/status', 'utf8');
    } catch {
      return; // no /proc here (macOS, Windows)
    }
    const read = await new ProcReader(32).text('/proc/self/status');
    expect(read.split('\n')[0]).toBe(real.split('\n')[0]);
    expect(read).toMatch(/^Tgid:\s*\d+$/m);
  });
});

describe('listProcesses', () => {
  it('caps environ above what execve can start a process with (about 6 MiB), so none starts unprovable', () => {
    expect(PROC_FILE_MAX).toBeGreaterThan(6 * 1024 * 1024);
  });

  it('lists a process whose environ is past the cap with no owner, and proves one exactly at it', async () => {
    const huge = `BIG=${'q'.repeat(PROC_FILE_MAX)}`;
    fakeProcess({ pid: 402, comm: 'node', ppid: 1, startTicks: 7002, env: [marked(A), huge] });
    fakeProcess({ pid: 403, comm: 'node', ppid: 1, startTicks: 7003, env: [marked(A)] });
    // Exactly at the cap, marker last: still read whole, still proven.
    const atCap = PROC_FILE_MAX - marked(A).length - 2 - 'BIG='.length;
    fakeProcess({
      pid: 404,
      comm: 'node',
      ppid: 1,
      startTicks: 7004,
      env: [`BIG=${'q'.repeat(atCap)}`, marked(A)],
    });
    const tooLarge: [number, string][] = [];
    const listed = await listProcesses(markers, [A], {
      procRoot: proc,
      self: 7,
      onTooLarge: (pid, file) => tooLarge.push([pid, file]),
    });
    expect(listed.map(({ pid, owner }) => [pid, owner])).toEqual([
      [402, null],
      [403, A],
      [404, A],
    ]);
    expect(tooLarge).toEqual([[402, 'environ']]);
  });

  it('finds a marker at the end of an environ longer than the reader started with', async () => {
    const padding = Array.from({ length: 500 }, (_, i) => `PAD_${i}=${'y'.repeat(150)}`);
    fakeProcess({
      pid: 400,
      comm: 'node',
      ppid: 1,
      startTicks: 7000,
      env: [...padding, marked(A)],
    });
    fakeProcess({ pid: 401, comm: 'sh', ppid: 1, startTicks: 7001, env: [marked(B)] });
    const listed = await listProcesses(
      markers,
      [A, B],
      { procRoot: proc, self: 7 },
      new ProcReader(32)
    );
    expect(listed.map(({ pid, owner }) => [pid, owner])).toEqual([
      [400, A],
      [401, B],
    ]);
  });

  it("names each agent's processes, and no owner for tini, the controller or a stranger", async () => {
    boxA();
    fakeProcess({ pid: 300, comm: 'sleep', ppid: 1, startTicks: 6000, env: BASE });
    const listed = await listProcesses(markers, [A, B], { procRoot: proc, self: 7 });
    expect(listed.map(({ pid, owner }) => [pid, owner])).toEqual([
      [1, null],
      [101, A],
      [102, A],
      [150, A],
      [201, B],
      [202, B],
      [300, null],
    ]);
  });

  it("still proves a detached child is the agent's once it is reparented to pid 1", async () => {
    boxA();
    // The CLI runs `python3 server.py &` through a shell that exits: the
    // child is first under the CLI's shell, then reparented to tini (box A,
    // 27 Oct: a python3 outlived its agent this way for about 1.5 h).
    fakeProcess({ pid: 160, comm: 'sh', ppid: 150, startTicks: 5100, env: [...BASE, marked(A)] });
    fakeProcess({
      pid: 161,
      comm: 'python3',
      ppid: 160,
      startTicks: 5200,
      env: [...BASE, marked(A)],
    });
    const before = await processesOf(markers, A, { procRoot: proc, self: 7 });
    expect(before.find((entry) => entry.pid === 161)).toEqual({
      pid: 161,
      ppid: 160,
      startTicks: 5200,
      owner: A,
    });
    rmSync(join(proc, '160'), { recursive: true });
    reparent(161, 'python3', 1, 5200);
    // Its agent rests: the host and CLI are gone, only the orphan is left.
    for (const pid of [101, 102, 150]) rmSync(join(proc, String(pid)), { recursive: true });
    const after = await processesOf(markers, A, { procRoot: proc, self: 7 });
    expect(after).toEqual([{ pid: 161, ppid: 1, startTicks: 5200, owner: A }]);
    // Agent B's own processes never count as A's.
    expect((await processesOf(markers, B, { procRoot: proc, self: 7 })).map((e) => e.pid)).toEqual([
      201, 202,
    ]);
  });

  it('gives no owner to a detached child that dropped or forged its marker', async () => {
    boxA();
    fakeProcess({ pid: 170, comm: 'env', ppid: 1, startTicks: 5400, env: BASE });
    fakeProcess({
      pid: 171,
      comm: 'node',
      ppid: 1,
      startTicks: 5500,
      env: [...BASE, `SWITCH_OWNER_MARKER=${A}`],
    });
    fakeProcess({
      pid: 172,
      comm: 'node',
      ppid: 1,
      startTicks: 5600,
      env: [...BASE, marked(A), marked(B)],
    });
    const listed = await listProcesses(markers, [A, B], { procRoot: proc, self: 7 });
    expect(
      listed.filter((e) => e.pid >= 170 && e.pid < 200).map(({ pid, owner }) => [pid, owner])
    ).toEqual([
      [170, null],
      [171, null],
      [172, null],
    ]);
  });

  it('skips threads, entries that vanish mid-read, and lists one it cannot read the environment of', async () => {
    boxA();
    fakeProcess({ pid: 1502, comm: 'claude', ppid: 102, startTicks: 4100, env: [], tgid: 150 });
    mkdirSync(join(proc, '400'));
    writeFileSync(join(proc, 'self'), '');
    mkdirSync(join(proc, 'sys'));
    fakeProcess({ pid: 500, comm: 'other', ppid: 1, startTicks: 7000, env: [marked(A)] });
    const unreadable = join(proc, '500', 'environ');
    chmodSync(unreadable, 0o000);
    const root = process.getuid?.() === 0;
    const listed = await listProcesses(markers, [A, B], { procRoot: proc, self: 7 });
    expect(listed.map((entry) => entry.pid)).toEqual([1, 101, 102, 150, 201, 202, 500]);
    if (!root) expect(listed.at(-1)?.owner).toBeNull();
    chmodSync(unreadable, 0o600);
  });

  it.skipIf(process.getuid?.() === 0)(
    'skips a process whose status or stat cannot be read, and lists the rest',
    async () => {
      boxA();
      fakeProcess({ pid: 600, comm: 'other', ppid: 1, startTicks: 8000, env: [marked(A)] });
      chmodSync(join(proc, '600', 'stat'), 0o000);
      const listed = await listProcesses(markers, [A, B], { procRoot: proc, self: 7 });
      expect(listed.map((entry) => entry.pid)).toEqual([1, 101, 102, 150, 201, 202]);
      chmodSync(join(proc, '600', 'stat'), 0o600);
    }
  );

  it('lists nothing where there is no /proc', async () => {
    expect(await listProcesses(markers, [A], { procRoot: join(dir, 'missing') })).toEqual([]);
  });
});

describe('signalProven', () => {
  it('signals a proven process, the orphan included', async () => {
    boxA();
    fakeProcess({
      pid: 161,
      comm: 'python3',
      ppid: 1,
      startTicks: 5200,
      env: [...BASE, marked(A)],
    });
    const kill = vi.fn();
    const [orphan] = (await processesOf(markers, A, { procRoot: proc, self: 7 })).filter(
      (entry) => entry.pid === 161
    );
    expect(await signalProven(orphan!, 'SIGTERM', markers, { procRoot: proc, self: 7, kill })).toBe(
      'signalled'
    );
    expect(kill).toHaveBeenCalledWith(161, 'SIGTERM');
  });

  it('never signals a process with no owner', async () => {
    boxA();
    fakeProcess({ pid: 300, comm: 'sleep', ppid: 1, startTicks: 6000, env: BASE });
    const kill = vi.fn();
    const stranger = (await listProcesses(markers, [A], { procRoot: proc, self: 7 })).find(
      (entry) => entry.pid === 300
    )!;
    expect(await signalProven(stranger, 'SIGKILL', markers, { procRoot: proc, kill })).toBe(
      'not_proven'
    );
    // Nor one whose owner was filled in by hand, but whose marker does not prove it.
    expect(
      await signalProven({ ...stranger, owner: A }, 'SIGKILL', markers, { procRoot: proc, kill })
    ).toBe('not_proven');
    // Nor pid 1, nor this process.
    expect(
      await signalProven({ pid: 1, ppid: 0, startTicks: 100, owner: A }, 'SIGKILL', markers, {
        procRoot: proc,
        kill,
      })
    ).toBe('not_proven');
    expect(kill).not.toHaveBeenCalled();
  });

  it('does not signal an id handed on to a newer process, or one that has ended', async () => {
    boxA();
    fakeProcess({
      pid: 161,
      comm: 'python3',
      ppid: 1,
      startTicks: 5200,
      env: [...BASE, marked(A)],
    });
    const kill = vi.fn();
    const listed = (await processesOf(markers, A, { procRoot: proc, self: 7 })).find(
      (entry) => entry.pid === 161
    )!;
    // It exits, and its id goes to a new process, even another of A's.
    fakeProcess({ pid: 161, comm: 'node', ppid: 1, startTicks: 9100, env: [...BASE, marked(A)] });
    expect(await signalProven(listed, 'SIGTERM', markers, { procRoot: proc, kill })).toBe('gone');
    rmSync(join(proc, '161'), { recursive: true });
    expect(await signalProven(listed, 'SIGTERM', markers, { procRoot: proc, kill })).toBe('gone');
    expect(kill).not.toHaveBeenCalled();
  });

  it('answers gone when the process ends between the check and the signal', async () => {
    boxA();
    const kill = vi.fn(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    const [host] = await processesOf(markers, A, { procRoot: proc, self: 7 });
    expect(await signalProven(host!, 'SIGTERM', markers, { procRoot: proc, kill })).toBe('gone');
  });
});

/**
 * The real thing, where there is a /proc: a child detached through a shell
 * that exits keeps the marker it was started with, is reparented away from
 * its starter, is proven, and is stopped by its proof.
 */
describe.runIf(process.platform === 'linux')('on Linux', () => {
  it('proves and stops a real detached child reparented away from its starter', async () => {
    const pidFile = join(dir, 'child.pid');
    const shell = spawn('sh', ['-c', `sleep 60 >/dev/null 2>&1 & echo $! > "${pidFile}"`], {
      env: { ...process.env, ...markers.environmentFor(A) },
      stdio: 'ignore',
    });
    await new Promise((resolve) => shell.once('exit', resolve));
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    try {
      const entry = (await processesOf(markers, A)).find((listed) => listed.pid === pid);
      expect(entry?.owner).toBe(A);
      expect(entry?.ppid).not.toBe(shell.pid);
      expect(await signalProven(entry!, 'SIGTERM', markers)).toBe('signalled');
    } finally {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  });
});

describe('MarkerTable', () => {
  it("proves processes by each agent's current marker, without the key, and forgets an old one", async () => {
    const table = new MarkerTable();
    const first = markers.markerFor(A);
    table.set(A, first);
    expect(table.environmentFor(A)).toEqual({ SWITCH_OWNER_MARKER: first });
    expect(table.ownerOf(first, [A, B])).toBe(A);
    // A new launch: the old marker stops proving anything.
    table.set(A, 'e'.repeat(64));
    expect(table.ownerOf(first, [A, B])).toBeNull();
    table.forget(A);
    expect(table.environmentFor(A)).toEqual({});
    expect(() => table.set(B, 'not-a-marker')).toThrow();
  });

  it('works with listProcesses as the key does', async () => {
    boxA();
    const table = new MarkerTable();
    table.set(A, markers.markerFor(A));
    const listed = await listProcesses(table, [A, B], { procRoot: proc, self: 7 });
    expect(listed.filter((entry) => entry.owner === A).map((entry) => entry.pid)).toEqual([
      101, 102, 150,
    ]);
    expect(listed.some((entry) => entry.owner === B)).toBe(false);
  });
});
