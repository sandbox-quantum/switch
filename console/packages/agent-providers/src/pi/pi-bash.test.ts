import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PI_BASH_MARKER_ENV,
  parsePiBashRegistry,
  PiProcInspectionError,
  piBashArgsFingerprint,
  piBashProcessView,
  piBashPsArgsDigest,
  piProcSource,
  piProcessGroupMembers,
  readPiBashRegistry,
  readPiProcStat,
  readPiPsCommand,
  readPiPsLabelled,
  readPiPsTable,
  signalPiBashGroup,
  verifyPiBashGroup,
  type PiBashGroup,
} from './pi-bash';

let dir: string;
const spawned: number[] = [];
const locked: string[] = [];

/** Takes every permission away from a file or directory of the fake procfs. */
function lock(file: string) {
  fs.chmodSync(file, 0o000);
  locked.push(file);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-bash-test-'));
});

afterEach(() => {
  // Undo the permission changes of the inspection tests, so the directory can be removed.
  for (const file of locked.splice(0)) fs.chmodSync(file, 0o700);
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const line = (entry: Record<string, unknown>) =>
  JSON.stringify({ v: 1, t: 1, instance: 'i1', ...entry });

function group(extra: Partial<PiBashGroup> = {}): PiBashGroup {
  return {
    instance: 'i1',
    toolCallId: 't1',
    run: 1,
    marker: 'i1:t1',
    pid: 4242,
    pgid: 4242,
    starttime: '1000',
    shellExited: false,
    killedByBridge: false,
    bridgeKillFailed: false,
    ...extra,
  };
}

/** A fake procfs: `processes` maps pid → stat fields and environment. */
function fakeProc(
  processes: Record<
    number,
    { state?: string; pgrp: number; sid: number; starttime: string; env?: string[] }
  >
) {
  const root = path.join(dir, 'proc');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, 'self'), { recursive: true });
  for (const [pid, proc] of Object.entries(processes)) {
    fs.mkdirSync(path.join(root, pid));
    const fields = [proc.state ?? 'S', '1', String(proc.pgrp), String(proc.sid)];
    while (fields.length < 19) fields.push('0');
    fields.push(proc.starttime, '0');
    fs.writeFileSync(path.join(root, pid, 'stat'), `${pid} (bash (x) y) ${fields.join(' ')}\n`);
    fs.writeFileSync(path.join(root, pid, 'environ'), `${(proc.env ?? []).join('\0')}\0`);
  }
  return { procRoot: root };
}

describe('registry', () => {
  it('folds intent, spawn, kill and exit records per call', () => {
    const text = [
      line({ event: 'intent', toolCallId: 't1', run: 2, marker: 'i1:t1' }),
      line({
        event: 'spawn',
        toolCallId: 't1',
        run: 2,
        marker: 'i1:t1',
        pid: 10,
        pgid: 10,
        starttime: '55',
      }),
      line({ event: 'intent', toolCallId: 't2', run: 2, marker: 'i1:t2' }),
      line({ event: 'kill', toolCallId: 't1', pid: 10, why: 'abort' }),
      line({ event: 'exit', toolCallId: 't1', pid: 10, code: null, signal: 'SIGKILL' }),
      '',
    ].join('\n');
    expect(parsePiBashRegistry(text)).toEqual({
      groups: [
        {
          instance: 'i1',
          toolCallId: 't1',
          run: 2,
          marker: 'i1:t1',
          pid: 10,
          pgid: 10,
          starttime: '55',
          shellExited: true,
          killedByBridge: true,
          bridgeKillFailed: false,
        },
      ],
      unspawned: [{ instance: 'i1', toolCallId: 't2', run: 2, marker: 'i1:t2' }],
      invalidLines: 0,
    });
  });

  it('keeps a kill whose signal failed apart from a kill that was sent', () => {
    const spawn = (toolCallId: string, pid: number) =>
      line({ event: 'spawn', toolCallId, marker: 'm', pid, pgid: pid, starttime: '5' });
    const text = [
      spawn('t1', 10),
      line({ event: 'kill', toolCallId: 't1', pid: 10, why: 'abort', sent: false, error: 'EPERM' }),
      spawn('t2', 20),
      line({ event: 'kill', toolCallId: 't2', pid: 20, why: 'timeout', sent: true }),
      // ESRCH: no process was left in the group, so its state is known, not unknown (R7-C).
      spawn('t3', 30),
      line({ event: 'kill', toolCallId: 't3', pid: 30, why: 'abort', sent: false, error: 'ESRCH' }),
    ].join('\n');
    expect(
      parsePiBashRegistry(text).groups.map(({ toolCallId, killedByBridge, bridgeKillFailed }) => ({
        toolCallId,
        killedByBridge,
        bridgeKillFailed,
      }))
    ).toEqual([
      { toolCallId: 't1', killedByBridge: false, bridgeKillFailed: true },
      { toolCallId: 't2', killedByBridge: true, bridgeKillFailed: false },
      { toolCallId: 't3', killedByBridge: false, bridgeKillFailed: false },
    ]);
  });

  // The bridge writes one `kill` per shell (R7-C): the first stands, a second is not trusted, so a
  // group never ends up both signalled and in an unknown state.
  it.each([
    [{ sent: true }, { sent: false, error: 'ESRCH' }, true, false],
    [{ sent: false, error: 'EPERM' }, { sent: true }, false, true],
    [{ sent: false, error: 'ESRCH' }, { sent: false, error: 'EPERM' }, false, false],
  ])(
    'keeps the first kill of a group and counts a second (%o, then %o) (R7-C)',
    (first, second, killedByBridge, bridgeKillFailed) => {
      const text = [
        line({ event: 'spawn', toolCallId: 't1', marker: 'm', pid: 10, pgid: 10, starttime: '5' }),
        line({ event: 'kill', toolCallId: 't1', pid: 10, why: 'timeout', ...first }),
        line({ event: 'kill', toolCallId: 't1', pid: 10, why: 'abort', ...second }),
      ].join('\n');
      const registry = parsePiBashRegistry(text);
      expect(registry.groups[0]).toMatchObject({ killedByBridge, bridgeKillFailed });
      expect(registry.invalidLines).toBe(1);
    }
  );

  it('counts broken and foreign lines without trusting them', () => {
    const text = [
      line({ event: 'spawn', toolCallId: 't1', marker: 'm', pid: 10, pgid: 10, starttime: '5' }),
      '{"v":1,"instance":"i1","toolCallId":"t9","event":"spawn","pid":1',
      line({ event: 'spawn', toolCallId: 't3', marker: 'm', pid: 1, pgid: 1 }),
      line({ event: 'spawn', toolCallId: 't4', marker: 'm', pid: 20, pgid: 21 }),
      line({ event: 'spawn', toolCallId: 't5', marker: 'm', pid: -5, pgid: -5 }),
      line({ event: 'exit', toolCallId: 't1', pid: 11 }),
      line({ event: 'exit', toolCallId: 'nobody', pid: 10 }),
      JSON.stringify({ v: 2, instance: 'i1', toolCallId: 't6', event: 'spawn', pid: 30, pgid: 30 }),
      line({ event: 'other', toolCallId: 't1' }),
      '[]',
    ].join('\n');
    const registry = parsePiBashRegistry(text);
    expect(registry.groups.map((entry) => entry.toolCallId)).toEqual(['t1']);
    expect(registry.groups[0]?.shellExited).toBe(false);
    expect(registry.invalidLines).toBe(9);
  });

  it('reads a missing file as empty and rethrows other errors', () => {
    expect(readPiBashRegistry(path.join(dir, 'none.jsonl'))).toEqual({
      groups: [],
      unspawned: [],
      invalidLines: 0,
    });
    expect(() => readPiBashRegistry(dir)).toThrow();
  });
});

describe('verification (fake procfs)', () => {
  const marker = `${PI_BASH_MARKER_ENV}=i1:t1`;

  it('accepts a live leader with the recorded start time and the marker', () => {
    const proc = fakeProc({
      4242: { pgrp: 4242, sid: 4242, starttime: '1000', env: ['A=1', marker] },
    });
    expect(verifyPiBashGroup(group(), proc)).toEqual({
      ok: true,
      reason: 'leader_verified',
      members: 1,
    });
  });

  it('refuses a reused PID (other start time)', () => {
    const proc = fakeProc({ 4242: { pgrp: 4242, sid: 4242, starttime: '2000', env: [marker] } });
    expect(verifyPiBashGroup(group(), proc)).toMatchObject({
      ok: false,
      reason: 'leader_starttime_mismatch',
    });
  });

  it('refuses a leader without the marker', () => {
    const proc = fakeProc({
      4242: { pgrp: 4242, sid: 4242, starttime: '1000', env: [`${PI_BASH_MARKER_ENV}=i1:t2`] },
    });
    expect(verifyPiBashGroup(group(), proc)).toMatchObject({
      ok: false,
      reason: 'leader_without_marker',
    });
  });

  // Whole entries, compared as bytes (R6-B): not a longer entry that starts with the marker, and
  // not bytes that only decode to the recorded text (a byte that is not UTF-8 reads as U+FFFD).
  it.each([
    ['a longer entry', Buffer.from(`${PI_BASH_MARKER_ENV}=i1:t1x`), 'i1:t1'],
    [
      'bytes that are not UTF-8',
      Buffer.from(`${PI_BASH_MARKER_ENV}=i1:\xff`, 'latin1'),
      'i1:\ufffd',
    ],
  ])('refuses a leader whose environment holds %s', (_name, entry, marker) => {
    const proc = fakeProc({ 4242: { pgrp: 4242, sid: 4242, starttime: '1000' } });
    fs.writeFileSync(
      path.join(proc.procRoot, '4242', 'environ'),
      Buffer.concat([Buffer.from('A=1\0'), entry, Buffer.from('\0')])
    );
    expect(verifyPiBashGroup(group({ marker }), proc)).toMatchObject({
      ok: false,
      reason: 'leader_without_marker',
    });
  });

  it('refuses a live leader when the start time was not recorded', () => {
    const proc = fakeProc({ 4242: { pgrp: 4242, sid: 4242, starttime: '1000', env: [marker] } });
    expect(verifyPiBashGroup(group({ starttime: null }), proc)).toMatchObject({
      ok: false,
      reason: 'starttime_unknown',
    });
  });

  it('accepts members of a group whose leader is gone when each carries the marker', () => {
    const proc = fakeProc({
      5000: { pgrp: 4242, sid: 4242, starttime: '1100', env: [marker] },
      5001: { pgrp: 4242, sid: 4242, starttime: '1200', env: [marker, 'B=2'] },
      5002: { state: 'Z', pgrp: 4242, sid: 4242, starttime: '1300' },
      6000: { pgrp: 6000, sid: 6000, starttime: '1' },
    });
    expect(verifyPiBashGroup(group(), proc)).toEqual({
      ok: true,
      reason: 'members_verified',
      members: 2,
    });
  });

  it('treats a zombie leader as gone', () => {
    const proc = fakeProc({
      4242: { state: 'Z', pgrp: 4242, sid: 4242, starttime: '1000' },
      5000: { pgrp: 4242, sid: 4242, starttime: '1100', env: [marker] },
    });
    expect(verifyPiBashGroup(group(), proc)).toMatchObject({
      ok: true,
      reason: 'members_verified',
    });
  });

  it.each([
    [
      'a member without the marker',
      {
        5000: { pgrp: 4242, sid: 4242, starttime: '1', env: [marker] },
        5001: { pgrp: 4242, sid: 4242, starttime: '2' },
      },
      'member_without_marker',
    ],
    [
      'a member in another session',
      { 5000: { pgrp: 4242, sid: 7, starttime: '1', env: [marker] } },
      'member_outside_session',
    ],
    ['no members', {}, 'group_empty'],
  ])('refuses a leaderless group with %s', (_name, processes, reason) => {
    const proc = fakeProc(processes);
    expect(verifyPiBashGroup(group(), proc)).toMatchObject({ ok: false, reason });
  });

  it('signals only verified groups', () => {
    const kill = vi.fn();
    const good = fakeProc({ 4242: { pgrp: 4242, sid: 4242, starttime: '1000', env: [marker] } });
    expect(signalPiBashGroup(group(), 'SIGTERM', { ...good, kill })).toMatchObject({ sent: true });
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
    kill.mockClear();
    fs.rmSync(path.join(dir, 'proc'), { recursive: true });
    const reused = fakeProc({ 4242: { pgrp: 4242, sid: 4242, starttime: '9', env: [marker] } });
    expect(signalPiBashGroup(group(), 'SIGKILL', { ...reused, kill })).toMatchObject({
      sent: false,
      verification: { ok: false, reason: 'leader_starttime_mismatch' },
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it('reports a kill that fails', () => {
    const proc = fakeProc({ 4242: { pgrp: 4242, sid: 4242, starttime: '1000', env: [marker] } });
    const kill = () => {
      throw Object.assign(new Error('nope'), { code: 'EPERM' });
    };
    expect(signalPiBashGroup(group(), 'SIGKILL', { ...proc, kill })).toMatchObject({
      sent: false,
      error: 'EPERM',
    });
  });

  it('parses a command name with spaces and parentheses', () => {
    const proc = fakeProc({ 77: { pgrp: 70, sid: 69, starttime: '123' } });
    expect(readPiProcStat(77, proc)).toEqual({
      pid: 77,
      state: 'S',
      pgrp: 70,
      sid: 69,
      starttime: '123',
    });
    expect(readPiProcStat(78, proc)).toBeUndefined();
  });

  it('does not take a procfs it cannot list for an empty group', () => {
    const missing = { procRoot: path.join(dir, 'missing') };
    expect(() => piProcessGroupMembers(70, missing)).toThrow(PiProcInspectionError);
    // R7-C: a root that does not exist has no procfs, whoever passed it (`piProcSource`, as the
    // adapter has read it since R1-I): `ps` answers then, and a `ps` that cannot run is a failed
    // inspection too, never an empty group.
    expect(piBashProcessView(missing)).toBe('ps');
    expect(verifyPiBashGroup(group(), { ...missing, ps: path.join(dir, 'no-ps') })).toEqual({
      ok: false,
      reason: 'inspection_failed',
      members: null,
      error: 'ENOENT',
    });
  });

  it('reports EACCES on procfs as a failed inspection, not an empty group (ER-06)', () => {
    const proc = fakeProc({ 5000: { pgrp: 4242, sid: 4242, starttime: '1', env: [marker] } });
    lock(proc.procRoot);
    expect(() => piProcessGroupMembers(4242, proc)).toThrow(PiProcInspectionError);
    expect(verifyPiBashGroup(group(), proc)).toEqual({
      ok: false,
      reason: 'inspection_failed',
      members: null,
      error: 'EACCES',
    });
    const kill = vi.fn();
    expect(signalPiBashGroup(group(), 'SIGKILL', { ...proc, kill })).toMatchObject({
      sent: false,
      verification: { reason: 'inspection_failed' },
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it.each([
    ['a stat file', '5000/stat'],
    ['a process directory', '5000'],
    ['the leader’s environment', '4242/environ'],
  ])('reports a failed inspection when %s cannot be read', (_name, file) => {
    const proc = fakeProc({
      4242: { pgrp: 4242, sid: 4242, starttime: '1000', env: [marker] },
      5000: { pgrp: 4242, sid: 4242, starttime: '1', env: [marker] },
    });
    lock(path.join(proc.procRoot, file));
    expect(verifyPiBashGroup(group(), proc)).toMatchObject({
      ok: false,
      reason: 'inspection_failed',
      error: 'EACCES',
    });
  });

  it('treats only a vanished process as absent', () => {
    const proc = fakeProc({ 5000: { pgrp: 4242, sid: 4242, starttime: '1', env: [marker] } });
    fs.rmSync(path.join(proc.procRoot, '5000'), { recursive: true });
    expect(verifyPiBashGroup(group(), proc)).toEqual({
      ok: false,
      reason: 'group_empty',
      members: 0,
    });
    // A stat file that cannot be parsed is not a missing process either.
    fs.mkdirSync(path.join(proc.procRoot, '4242'));
    fs.writeFileSync(path.join(proc.procRoot, '4242', 'stat'), '4242 (x) S');
    expect(verifyPiBashGroup(group(), proc)).toMatchObject({ reason: 'inspection_failed' });
  });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The command line each decoy of `startGroup` was spawned with, by PID. */
const startedArgv = new Map<number, string[]>();
/** D-18: the label each decoy shell carries in its command line (as the bridge starts one). */
const startedLabel = new Map<number, string>();
const newLabel = () =>
  Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

async function startGroup(env: Record<string, string>, script = 'sleep 30; true') {
  const label = newLabel();
  const child = spawn('/bin/bash', ['-c', script, '/bin/bash', label], {
    detached: true,
    stdio: 'ignore',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
  });
  const pid = child.pid as number;
  spawned.push(pid);
  startedArgv.set(pid, ['/bin/bash', '-c', script, '/bin/bash', label]);
  startedLabel.set(pid, label);
  child.unref();
  await new Promise((resolve) => setTimeout(resolve, 50));
  return pid;
}

describe('verification (real processes)', () => {
  it('stops a real group it can verify', async () => {
    const pid = await startGroup({ [PI_BASH_MARKER_ENV]: 'i1:real' });
    const real = group({
      toolCallId: 'real',
      marker: 'i1:real',
      pid,
      pgid: pid,
      starttime: readPiProcStat(pid)?.starttime ?? null,
    });
    expect(signalPiBashGroup(real, 'SIGKILL')).toMatchObject({
      sent: true,
      verification: { ok: true, reason: 'leader_verified' },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(piProcessGroupMembers(pid)).toEqual([]);
  });

  it('leaves alone a process that does not match the record', async () => {
    const pid = await startGroup({});
    const starttime = readPiProcStat(pid)?.starttime ?? null;
    const decoys = [
      group({ pid, pgid: pid, starttime: `${starttime}0`, marker: 'i1:x' }),
      group({ pid, pgid: pid, starttime, marker: 'i1:x' }),
    ];
    for (const decoy of decoys) expect(signalPiBashGroup(decoy, 'SIGKILL').sent).toBe(false);
    expect(alive(pid)).toBe(true);
  });

  // The marker carries Pi's `toolCallId`, which may be any text (R6-B): Polish letters and a
  // character outside the BMP, next to an ASCII control.
  const UNICODE = 'i1:zażółć-🐚';
  const record = (pid: number, marker: string) =>
    group({ marker, pid, pgid: pid, starttime: readPiProcStat(pid)?.starttime ?? null });

  it.each([
    ['a Unicode', UNICODE],
    ['an ASCII', 'i1:ascii-1'],
  ])('verifies a live leader with %s marker (R6-B)', async (_name, marker) => {
    const pid = await startGroup({ [PI_BASH_MARKER_ENV]: marker });
    expect(verifyPiBashGroup(record(pid, marker))).toMatchObject({
      ok: true,
      reason: 'leader_verified',
    });
  });

  it('verifies the members of a leaderless group with a Unicode marker (R6-B)', async () => {
    const pid = await startGroup({ [PI_BASH_MARKER_ENV]: UNICODE }, 'sleep 30 & sleep 30; true');
    const recorded = record(pid, UNICODE);
    process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 100 && readPiProcStat(pid) !== undefined; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(readPiProcStat(pid)).toBeUndefined();
    expect(verifyPiBashGroup(recorded)).toMatchObject({ ok: true, reason: 'members_verified' });
  });

  it.each([
    // another call's marker, one character apart
    ['another Unicode marker', UNICODE, 'i1:zażółć-🐛'],
    // what the leader's UTF-8 bytes of `ż` read as Latin-1: equal as text, not as bytes
    ['a marker that only matches the bytes as Latin-1 text', 'i1:zaż', 'i1:zaÅ¼'],
  ])('refuses a live leader whose record holds %s (R6-B)', async (_name, carried, recorded) => {
    const pid = await startGroup({ [PI_BASH_MARKER_ENV]: carried });
    expect(signalPiBashGroup(record(pid, recorded), 'SIGKILL')).toMatchObject({
      sent: false,
      verification: { ok: false, reason: 'leader_without_marker' },
    });
    expect(alive(pid)).toBe(true);
  });
});

// D-15: without procfs (macOS) the checks read `ps`. On Linux the tests hide procfs (a root that
// does not exist, or an empty directory) and pass `ps`, so the same code runs as on macOS.
describe('process view (D-15)', () => {
  it('reads procfs where it is, ps where the root is absent or not a procfs', () => {
    const fake = fakeProc({});
    const empty = path.join(dir, 'empty');
    fs.mkdirSync(empty);
    const missing = path.join(dir, 'missing');
    expect(piBashProcessView()).toBe('procfs');
    expect(piBashProcessView({ ...fake, ps: 'ps' })).toBe('procfs');
    expect(piBashProcessView({ procRoot: missing, ps: 'ps' })).toBe('ps');
    expect(piBashProcessView({ procRoot: empty, ps: 'ps' })).toBe('ps');
    fs.writeFileSync(path.join(dir, 'file'), '');
    expect(piBashProcessView({ procRoot: path.join(dir, 'file'), ps: 'ps' })).toBe('ps');
    // R7-C (`piProcSource`): a root that does not exist has no procfs, whoever passed it (`ps`,
    // as the adapter and the store read it since R1-I); an empty one someone passed without `ps`
    // is no source at all (`none`): reported as procfs here, refused by the check.
    expect(piBashProcessView({ procRoot: missing })).toBe('ps');
    expect(piBashProcessView({ procRoot: empty })).toBe('procfs');
    expect(verifyPiBashGroup(group(), { procRoot: empty })).toEqual({
      ok: false,
      reason: 'inspection_failed',
      members: null,
      error: 'no_source',
    });
  });

  it('keeps a procfs root it cannot list on the procfs path (a failed inspection)', () => {
    const proc = fakeProc({});
    lock(proc.procRoot);
    expect(piBashProcessView({ ...proc, ps: 'ps' })).toBe('procfs');
    expect(verifyPiBashGroup(group(), { ...proc, ps: 'ps' })).toMatchObject({
      ok: false,
      reason: 'inspection_failed',
      error: 'EACCES',
    });
  });

  it('records a spawn without procfs with its lstart', () => {
    const text = [
      line({
        event: 'spawn',
        toolCallId: 't1',
        marker: 'm',
        pid: 10,
        pgid: 10,
        starttime: null,
        lstart: ' Wed Nov  4 09:10:58 2026 ',
      }),
      line({ event: 'spawn', toolCallId: 't2', marker: 'm', pid: 11, pgid: 11, lstart: null }),
      line({ event: 'spawn', toolCallId: 't3', marker: 'm', pid: 12, pgid: 12, lstart: '  ' }),
    ].join('\n');
    const groups = parsePiBashRegistry(text).groups;
    expect(groups[0]).toMatchObject({ starttime: null, lstart: 'Wed Nov 4 09:10:58 2026' });
    expect(groups[1]).not.toHaveProperty('lstart');
    expect(groups[2]).not.toHaveProperty('lstart');
  });
});

// The `ps` fixtures of the D-15 tests: what the bridge recorded, and a `ps` that prints a table.
const FAKE_START = 'Wed Nov 4 09:10:58 2026';
/** The bridge's process (Pi), the shell's parent, and its start. */
const FAKE_PARENT = 4000;
const FAKE_PARENT_START = 'Wed Nov 4 09:00:00 2026';
/** D-18: the fake shell's label, a word of its command line as the bridge puts it there. */
const FAKE_LABEL = '0123456789abcdef0123456789abcdef';
/** The command line the fake shell was spawned with (`$0` the shell's path, `$1` its label). */
const FAKE_ARGV = ['/bin/bash', '-c', 'sleep 30; true', '/bin/bash', FAKE_LABEL];
const fakeUid = process.geteuid?.() ?? 0;
/** Padded like `ps` pads it: two spaces before a one-digit day. */
const padStart = (start: string) => start.replace(/ (\d) /, '  $1 ');

/**
 * A `ps` that prints `rows` (`pid ppid pgid uid stat lstart`) when asked for the table (`-A`) and
 * `command` (`pid ppid lstart args`) when asked for one process (`-p`), then ends with `exit`.
 */
function fakePs(rows: string[], exit = 0, command: string = fakeCommand()) {
  const id = Math.random().toString(36).slice(2);
  const table = path.join(dir, `ps-table-${id}`);
  fs.writeFileSync(table, rows.map((text) => `${text}\n`).join(''));
  const one = path.join(dir, `ps-one-${id}`);
  fs.writeFileSync(one, `${command}\n`);
  const script = path.join(dir, `ps-${id}`);
  fs.writeFileSync(
    script,
    `#!/bin/sh\nif [ "$1" = -A ]; then cat '${table}'; else cat '${one}'; fi\nexit ${exit}\n`,
    { mode: 0o700 }
  );
  return { procRoot: path.join(dir, 'no-proc'), ps: script };
}
const fakeRow = (
  pid: number,
  pgid: number,
  stat = 'Ss',
  start = FAKE_START,
  user = fakeUid,
  ppid = FAKE_PARENT
) => `  ${pid}  ${ppid}  ${pgid}  ${user} ${stat}   ${padStart(start)}`;
/** The row of the shell's live parent, with the start the bridge recorded. */
const parentRow = (start = FAKE_PARENT_START) =>
  fakeRow(FAKE_PARENT, FAKE_PARENT, 'Sl', start, fakeUid, 1);
const fakeCommand = (
  pid = 4242,
  ppid = FAKE_PARENT,
  start = FAKE_START,
  args = FAKE_ARGV.join(' ')
) => `  ${pid}  ${ppid} ${padStart(start)} ${args}`;
/** A group as the bridge records it without procfs. */
const recordedPs = (extra: Partial<PiBashGroup> = {}) =>
  group({
    starttime: null,
    lstart: FAKE_START,
    ppid: FAKE_PARENT,
    parentLstart: FAKE_PARENT_START,
    args: piBashArgsFingerprint(FAKE_ARGV),
    label: FAKE_LABEL,
    psArgs: piBashPsArgsDigest(FAKE_ARGV.join(' ')),
    ...extra,
  });

describe('verification (fake ps, D-15)', () => {
  const START = FAKE_START;
  const uid = fakeUid;
  const row = (pid: number, pgid: number, stat = 'Ss', start = START, user = uid) =>
    fakeRow(pid, pgid, stat, start, user);
  const recorded = recordedPs;

  it('reads the table with lstart collapsed', () => {
    expect([...readPiPsTable(fakePs([row(4242, 4242), row(1, 1, 'S')])).values()]).toEqual([
      { pid: 4242, ppid: FAKE_PARENT, pgid: 4242, uid, state: 'Ss', lstart: START },
      { pid: 1, ppid: FAKE_PARENT, pgid: 1, uid, state: 'S', lstart: START },
    ]);
  });

  it('accepts a live leader with the recorded lstart, in its group, of this user', () => {
    const ps = fakePs([
      row(4242, 4242),
      row(5000, 4242, 'S'),
      row(5001, 4242, 'Z'),
      row(1, 1),
      parentRow(),
    ]);
    expect(verifyPiBashGroup(recorded(), ps)).toEqual({
      ok: true,
      reason: 'leader_verified',
      members: 2,
    });
    const kill = vi.fn();
    expect(signalPiBashGroup(recorded(), 'SIGKILL', { ...ps, kill })).toMatchObject({
      sent: true,
    });
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  it.each([
    [
      'a reused PID (another lstart)',
      [row(4242, 4242, 'Ss', 'Wed Nov 4 09:10:59 2026')],
      {},
      'leader_starttime_mismatch',
    ],
    ['an unrecorded lstart', [row(4242, 4242)], { lstart: undefined }, 'starttime_unknown'],
    ['a leader in another group', [row(4242, 7)], {}, 'leader_outside_group'],
    ['a leader of another user', [row(4242, 4242, 'Ss', START, uid + 1)], {}, 'leader_other_user'],
    [
      'a gone leader with members (no marker can be read)',
      [row(4242, 4242, 'Z'), row(5000, 4242, 'S')],
      {},
      'members_unverifiable',
    ],
    ['no members', [row(1, 1)], {}, 'group_empty'],
    ['only a zombie leader', [row(4242, 4242, 'Z+'), row(1, 1)], {}, 'group_empty'],
  ])('refuses %s and sends nothing', (_name, rows, extra, reason) => {
    const ps = fakePs(rows);
    const kill = vi.fn();
    expect(signalPiBashGroup(recorded(extra), 'SIGKILL', { ...ps, kill })).toMatchObject({
      sent: false,
      verification: { ok: false, reason },
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it('checks the user against the given uid', () => {
    const ps = fakePs([row(4242, 4242)]);
    expect(verifyPiBashGroup(recorded(), { ...ps, uid: uid + 1 })).toMatchObject({
      ok: false,
      reason: 'leader_other_user',
    });
  });

  it.each([
    ['ps fails', [row(4242, 4242)], 1, 'exit 1'],
    ['ps prints a line that is not a row', [row(4242, 4242), 'garbage'], 0, 'malformed'],
    ['ps prints a PID twice', [row(4242, 4242), row(4242, 4242)], 0, 'malformed'],
    ['ps prints nothing', [], 0, 'empty'],
  ])('leaves the group unknown when %s', (_name, rows, exit, error) => {
    const ps = fakePs(rows, exit);
    const kill = vi.fn();
    expect(signalPiBashGroup(recorded(), 'SIGKILL', { ...ps, kill })).toEqual({
      sent: false,
      verification: { ok: false, reason: 'inspection_failed', members: null, error },
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it('leaves the group unknown when ps cannot be run', () => {
    const kill = vi.fn();
    const missing = { procRoot: path.join(dir, 'no-proc'), ps: path.join(dir, 'no-ps') };
    expect(() => readPiPsTable(missing)).toThrow(PiProcInspectionError);
    expect(signalPiBashGroup(recorded(), 'SIGKILL', { ...missing, kill })).toEqual({
      sent: false,
      verification: { ok: false, reason: 'inspection_failed', members: null, error: 'ENOENT' },
    });
    expect(kill).not.toHaveBeenCalled();
  });
});

/** `lstart` of a process as the bridge records it without procfs. */
function psLstart(pid: number): string | undefined {
  const result = spawnSync('ps', ['-ww', '-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' },
  });
  const text = result.stdout.trim().replace(/\s+/g, ' ');
  return result.status === 0 && text !== '' ? text : undefined;
}

/** D-18: the digest of a process's command line as the bridge records it (`cmd`, without procfs). */
function psArgsOf(pid: number): string | undefined {
  try {
    return piBashPsArgsDigest(readPiPsCommand(pid).args);
  } catch {
    return undefined;
  }
}

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('verification (real processes, ps, D-15)', () => {
  // E12-01: only the processes the test started.
  const hidden = () => ({ procRoot: path.join(dir, 'no-proc'), ps: 'ps' });
  // Recorded as the bridge records it: the decoy's parent is this test's process (R11-A).
  const both = (pid: number, marker: string, extra: Partial<PiBashGroup> = {}) =>
    group({
      toolCallId: marker,
      marker,
      pid,
      pgid: pid,
      starttime: readPiProcStat(pid)?.starttime ?? null,
      lstart: psLstart(pid),
      ppid: process.pid,
      parentLstart: psLstart(process.pid),
      args: piBashArgsFingerprint(startedArgv.get(pid) ?? []),
      label: startedLabel.get(pid),
      psArgs: psArgsOf(pid),
      ...extra,
    });

  it('stops a real group it can verify through ps', async () => {
    const pid = await startGroup({ [PI_BASH_MARKER_ENV]: 'i1:ps' }, 'sleep 30 & sleep 30; true');
    const record = both(pid, 'i1:ps');
    expect(record.lstart).toBeDefined();
    expect(signalPiBashGroup(record, 'SIGKILL', hidden())).toMatchObject({
      sent: true,
      verification: { ok: true, reason: 'leader_verified', members: 3 },
    });
    await waitFor(() => piProcessGroupMembers(pid).length === 0);
    expect(verifyPiBashGroup(record, hidden())).toEqual({
      ok: false,
      reason: 'group_empty',
      members: 0,
    });
  });

  it.each([
    ['another lstart (a reused PID)', { lstart: 'Thu Jan 1 00:00:00 1970' }, {}],
    ['no recorded lstart', { lstart: undefined }, {}],
    ['another user', {}, { uid: (process.geteuid?.() ?? 0) + 1 }],
  ])('leaves alone a real leader with %s', async (_name, extra, options) => {
    const pid = await startGroup({ [PI_BASH_MARKER_ENV]: 'i1:keep' });
    expect(
      signalPiBashGroup(both(pid, 'i1:keep', extra), 'SIGKILL', { ...hidden(), ...options }).sent
    ).toBe(false);
    expect(alive(pid)).toBe(true);
  });

  it('leaves alone the members of a real group whose leader is gone', async () => {
    const pid = await startGroup(
      { [PI_BASH_MARKER_ENV]: 'i1:orphan' },
      'sleep 30 & sleep 30; true'
    );
    const record = both(pid, 'i1:orphan');
    const members = piProcessGroupMembers(pid).filter((stat) => stat.pid !== pid);
    expect(members).toHaveLength(2);
    process.kill(pid, 'SIGKILL');
    await waitFor(() => readPiProcStat(pid) === undefined);
    expect(signalPiBashGroup(record, 'SIGKILL', hidden())).toMatchObject({
      sent: false,
      verification: { ok: false, reason: 'members_unverifiable', members: 2 },
    });
    for (const member of members) expect(alive(member.pid)).toBe(true);
  });

  // Both paths on the same decoys: the same members, the same answer where `ps` can decide, and
  // `ps` never accepts a group procfs refuses.
  it('answers like procfs on the same processes, and never accepts more', async () => {
    const pid = await startGroup({ [PI_BASH_MARKER_ENV]: 'i1:cmp' }, 'sleep 30 & sleep 30; true');
    const record = both(pid, 'i1:cmp');
    const compare = (decoy: PiBashGroup) => {
      const procfs = verifyPiBashGroup(decoy);
      const ps = verifyPiBashGroup(decoy, hidden());
      expect(ps.members).toBe(procfs.members);
      if (ps.ok) expect(procfs.ok).toBe(true);
      return { procfs, ps };
    };
    for (const decoy of [
      record,
      both(pid, 'i1:cmp', { starttime: '1', lstart: 'Thu Jan 1 00:00:00 1970' }),
      both(pid, 'i1:cmp', { starttime: null, lstart: undefined }),
    ]) {
      const { procfs, ps } = compare(decoy);
      expect(ps).toEqual(procfs);
    }
    expect(compare(record).ps).toMatchObject({ ok: true, reason: 'leader_verified', members: 3 });
    process.kill(pid, 'SIGKILL');
    await waitFor(() => readPiProcStat(pid) === undefined);
    const leaderless = compare(record);
    expect(leaderless.procfs).toMatchObject({ ok: true, reason: 'members_verified', members: 2 });
    expect(leaderless.ps).toMatchObject({ ok: false, reason: 'members_unverifiable', members: 2 });
    process.kill(-pid, 'SIGKILL');
    await waitFor(() => piProcessGroupMembers(pid).length === 0);
    const gone = compare(record);
    expect(gone.ps).toEqual(gone.procfs);
    expect(gone.ps).toMatchObject({ reason: 'group_empty' });
  });
});

// Round 11 of stage 2 (`p1_stage2_r11_synthesis.md`): the attacks of both recheck legs (Codex
// A01–A09 and controls C01–C17, `codex-r11/auditor-a.attack.test.ts`; Sonnet S2-01), kept as
// regressions. The `ps` path accepts no group procfs would refuse (R11-A); a `ps` table that is
// not whole and in range is a failed inspection, never an empty group (R11-B); one source per
// shell (R11-C). Synthetic PIDs are only ever "signalled" through a `kill` spy.
describe('round 11 attacks: the ps path accepts no group procfs refuses (R11-A)', () => {
  /** A fake procfs with the leader 4242 only: its start time and its marker. */
  function procWith(starttime: string, marker: string) {
    return fakeProc({
      4242: { pgrp: 4242, sid: 4242, starttime, env: [`${PI_BASH_MARKER_ENV}=${marker}`] },
    });
  }
  const refusedBy = (
    rows: string[],
    extra: Partial<PiBashGroup> = {},
    command: string = fakeCommand()
  ) => {
    const kill = vi.fn();
    const result = signalPiBashGroup(recordedPs(extra), 'SIGKILL', {
      ...fakePs(rows, 0, command),
      kill,
    });
    expect(kill).not.toHaveBeenCalled();
    expect(result.sent).toBe(false);
    return result.verification;
  };

  it('accepts the recorded shell: a child of its live, recorded parent, with its command line', () => {
    const kill = vi.fn();
    expect(
      signalPiBashGroup(recordedPs(), 'SIGKILL', {
        ...fakePs([fakeRow(4242, 4242), parentRow()]),
        kill,
      })
    ).toMatchObject({ sent: true, verification: { ok: true, reason: 'leader_verified' } });
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  // A01 / Sonnet S2-01: another process got the PID in the same second (same PID, group, user and
  // `lstart`). Procfs refuses it (another start time, no marker); so must `ps`.
  it.each([
    [
      'spawned by another process',
      [fakeRow(4242, 4242, 'Ss', FAKE_START, fakeUid, 4999), parentRow(), fakeRow(4999, 4999)],
      {},
    ],
    ['whose recorded parent is gone', [fakeRow(4242, 4242)], {}],
    [
      'whose recorded parent PID is another process',
      [fakeRow(4242, 4242), parentRow('Wed Nov 4 09:05:00 2026')],
      {},
    ],
    [
      'whose recorded parent is a zombie',
      [fakeRow(4242, 4242), fakeRow(FAKE_PARENT, FAKE_PARENT, 'Z', FAKE_PARENT_START, fakeUid, 1)],
      {},
    ],
    [
      'whose recorded parent runs as another user',
      [
        fakeRow(4242, 4242),
        fakeRow(FAKE_PARENT, FAKE_PARENT, 'S', FAKE_PARENT_START, fakeUid + 1, 1),
      ],
      {},
    ],
    ['with no parent recorded', [fakeRow(4242, 4242), parentRow()], { ppid: undefined }],
    [
      'with no parent start recorded',
      [fakeRow(4242, 4242), parentRow()],
      { parentLstart: undefined },
    ],
  ])('A01: refuses a same-second PID reuse %s', (_name, rows, extra) => {
    expect(verifyPiBashGroup(group(), procWith('1009', 'foreign:a'))).toMatchObject({
      ok: false,
      reason: 'leader_starttime_mismatch',
    });
    expect(refusedBy(rows, extra)).toMatchObject({ ok: false, reason: 'leader_parent_mismatch' });
  });

  it('S2-01: refuses a row that only repeats the PID, group, user and lstart', () => {
    const kill = vi.fn();
    const ps = fakePs([`777 777 777 ${fakeUid} S ${FAKE_START}`], 0, fakeCommand(777, 777));
    const result = signalPiBashGroup(
      recordedPs({ pid: 777, pgid: 777, ppid: undefined, parentLstart: undefined }),
      'SIGKILL',
      { ...ps, kill }
    );
    expect(result.verification.ok).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('refuses a live process with the PID of a shell the bridge saw exit', () => {
    expect(refusedBy([fakeRow(4242, 4242), parentRow()], { shellExited: true })).toMatchObject({
      ok: false,
      reason: 'members_unverifiable',
    });
  });

  // A02 with data: the leader's command line is not the one it was spawned with (`exec`).
  it.each([
    ['another program', fakeCommand(4242, FAKE_PARENT, FAKE_START, 'sleep 30'), {}],
    ['no command line recorded', fakeCommand(), { args: undefined }],
    // Refused before any read: a read that fails changes nothing then.
    ['no command line recorded, nothing read', 'garbage', { args: undefined }],
    [
      'a command line split over lines that differs',
      fakeCommand(4242, FAKE_PARENT, FAKE_START, '/bin/bash -c sleep 31\n; true'),
      {},
    ],
  ])('A02: refuses a leader with %s', (_name, command, extra) => {
    expect(refusedBy([fakeRow(4242, 4242), parentRow()], extra, command)).toMatchObject({
      ok: false,
      reason: 'leader_command_mismatch',
    });
  });

  it('reads a command line over several lines, as ps prints it', () => {
    const ps = fakePs([], 0, fakeCommand(4242, FAKE_PARENT, FAKE_START, "/bin/bash -c 'a\nb'"));
    expect(readPiPsCommand(4242, ps)).toEqual({
      pid: 4242,
      ppid: FAKE_PARENT,
      lstart: FAKE_START,
      args: "/bin/bash -c 'a\nb'",
    });
    // Only letters and digits count: separators, quotes and bytes `ps` replaces do not.
    expect(piBashArgsFingerprint("/bin/bash -c 'a\nb'")).toBe(
      piBashArgsFingerprint(['/bin/bash', '-c', 'a b'])
    );
    expect(piBashArgsFingerprint(['/bin/bash', '-c', 'zażółć\tx'])).toBe(
      piBashArgsFingerprint('/bin/bash -c za????????.x')
    );
    expect(piBashArgsFingerprint(['/bin/bash', '-c', 'a'])).not.toBe(
      piBashArgsFingerprint(['/bin/bash', '-c', 'b'])
    );
  });

  it.each([
    ['another PID', fakeCommand(4243)],
    ['another parent', fakeCommand(4242, 4999)],
    ['another start', fakeCommand(4242, FAKE_PARENT, 'Wed Nov 4 09:10:59 2026')],
    ['a row that is not one', 'garbage'],
    ['a cut-off date', '4242 4000 Wed Nov  4'],
  ])('leaves the group unknown when the command line read shows %s', (_name, command) => {
    const kill = vi.fn();
    expect(
      signalPiBashGroup(recordedPs(), 'SIGKILL', {
        ...fakePs([fakeRow(4242, 4242), parentRow()], 0, command),
        kill,
      })
    ).toMatchObject({
      sent: false,
      verification: { ok: false, reason: 'inspection_failed', members: null },
    });
    expect(kill).not.toHaveBeenCalled();
  });

  // A02: a real leader runs `exec` without the marker; procfs refuses it, so must `ps`.
  it('A02: refuses a real leader after exec removed its marker', async () => {
    const gate = path.join(dir, 'exec-now');
    const script = `while [ ! -f '${gate}' ]; do sleep 0.01; done; exec env -u ${PI_BASH_MARKER_ENV} sleep 30`;
    const pid = await startGroup({ [PI_BASH_MARKER_ENV]: 'i1:exec' }, script);
    const hidden = { procRoot: path.join(dir, 'no-proc'), ps: 'ps' };
    const record = group({
      toolCallId: 'exec',
      marker: 'i1:exec',
      pid,
      pgid: pid,
      starttime: readPiProcStat(pid)?.starttime ?? null,
      lstart: psLstart(pid),
      ppid: process.pid,
      parentLstart: psLstart(process.pid),
      args: piBashArgsFingerprint(startedArgv.get(pid) ?? []),
      label: startedLabel.get(pid),
      psArgs: psArgsOf(pid),
    });
    expect(verifyPiBashGroup(record)).toMatchObject({ ok: true });
    expect(verifyPiBashGroup(record, hidden)).toMatchObject({ ok: true });
    fs.writeFileSync(gate, 'go');
    await waitFor(
      () => !fs.readFileSync(`/proc/${pid}/environ`).includes(Buffer.from(`${PI_BASH_MARKER_ENV}=`))
    );
    expect(verifyPiBashGroup(record)).toMatchObject({ ok: false, reason: 'leader_without_marker' });
    const kill = vi.fn();
    expect(signalPiBashGroup(record, 'SIGKILL', { ...hidden, kill })).toMatchObject({
      sent: false,
      verification: { ok: false, reason: 'leader_command_mismatch' },
    });
    expect(kill).not.toHaveBeenCalled();
    expect(alive(pid)).toBe(true);
  });

  // A real orphan: the recorded parent is gone (as Pi is after a stop). Not shown to be the
  // shell, so not signalled (the measured cost of R11-A, `p1_d15_stage2_fix2_impl.md`).
  it('refuses a real shell whose parent is gone', async () => {
    const pidFile = path.join(dir, 'orphan.pid');
    const label = newLabel();
    const parent = spawn(
      '/bin/sh',
      [
        '-c',
        `setsid /bin/bash -c 'sleep 30; true' /bin/bash ${label} & echo $! > '${pidFile}'; exec sleep 30`,
      ],
      { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } }
    );
    spawned.push(parent.pid as number);
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    spawned.push(pid);
    await waitFor(() => readPiProcStat(pid)?.pgrp === pid);
    const hidden = { procRoot: path.join(dir, 'no-proc'), ps: 'ps' };
    const record = group({
      pid,
      pgid: pid,
      starttime: null,
      lstart: psLstart(pid),
      ppid: parent.pid as number,
      parentLstart: psLstart(parent.pid as number),
      args: piBashArgsFingerprint(['/bin/bash', '-c', 'sleep 30; true', '/bin/bash', label]),
      label,
      psArgs: psArgsOf(pid),
    });
    expect(verifyPiBashGroup(record, hidden)).toMatchObject({
      ok: true,
      reason: 'leader_verified',
    });
    process.kill(-(parent.pid as number), 'SIGKILL');
    await waitFor(
      () => readPiProcStat(pid)?.pgrp === pid && readPiProcStat(parent.pid as number) === undefined
    );
    const kill = vi.fn();
    expect(signalPiBashGroup(record, 'SIGKILL', { ...hidden, kill })).toMatchObject({
      sent: false,
      verification: { ok: false, reason: 'leader_parent_mismatch' },
    });
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('round 11 attacks: a ps table not read whole is unknown, never empty (R11-B)', () => {
  const unknown = (rows: string[]) => {
    const kill = vi.fn();
    const result = signalPiBashGroup(recordedPs(), 'SIGKILL', { ...fakePs(rows), kill });
    expect(kill).not.toHaveBeenCalled();
    return result;
  };
  it.each([
    // A03: a date cut off mid-row
    ['a cut-off lstart', [`1 1 1 0 S Wed Nov 4`]],
    // A04: a state `ps` does not print
    ['an unknown state', [fakeRow(4242, 4242, 'NOT_A_STATE'), parentRow()]],
    ['a state with a foreign flag', [fakeRow(4242, 4242, 'Sq'), parentRow()]],
    // A05: a non-date
    ['unavailable for lstart', [fakeRow(4242, 4242, 'S', 'unavailable'), parentRow()]],
    ['an impossible date', [fakeRow(4242, 4242, 'S', 'Wed Foo 4 09:10:58 2026'), parentRow()]],
    ['an hour out of range', [fakeRow(4242, 4242, 'S', 'Wed Nov 4 24:10:58 2026'), parentRow()]],
    // A06: numbers out of range
    ['a PID beyond any pid_t', [`999999999999999999999 1 1 ${fakeUid} S ${FAKE_START}`]],
    ['a PID just beyond pid_t', [`2147483648 1 1 ${fakeUid} S ${FAKE_START}`]],
    ['a group beyond pid_t', [`5 1 2147483648 ${fakeUid} S ${FAKE_START}`]],
    ['a parent beyond pid_t', [`5 2147483648 5 ${fakeUid} S ${FAKE_START}`]],
    ['a user beyond uid_t', [`5 1 5 4294967295 S ${FAKE_START}`]],
    ['a signed number', [`+5 1 5 ${fakeUid} S ${FAKE_START}`]],
    // C05, C06
    ['a header', ['PID PPID PGID UID STAT LSTART']],
    ['a row cut before its numbers end', ['4242 4000 ']],
  ])('%s', (_name, rows) => {
    expect(unknown(rows)).toMatchObject({
      sent: false,
      verification: { ok: false, reason: 'inspection_failed', members: null, error: 'malformed' },
    });
  });

  it('A05: takes no non-date from the registry for a start time', () => {
    const text = [
      line({
        event: 'spawn',
        toolCallId: 'a',
        marker: 'm',
        pid: 10,
        pgid: 10,
        starttime: null,
        lstart: 'unavailable',
      }),
      line({
        event: 'spawn',
        toolCallId: 'b',
        marker: 'm',
        pid: 11,
        pgid: 11,
        starttime: null,
        lstart: 'Wed Nov 4',
      }),
    ].join('\n');
    for (const g of parsePiBashRegistry(text).groups) expect(g).not.toHaveProperty('lstart');
    const [first] = parsePiBashRegistry(text).groups;
    if (!first) throw new Error('no group');
    const kill = vi.fn();
    expect(
      signalPiBashGroup(first, 'SIGKILL', {
        ...fakePs([`10 1 10 ${fakeUid} S unavailable`]),
        kill,
      }).sent
    ).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  // Seen on Linux while a killed group exited: a dead process (`X`) whose group is -1.
  it('leaves out a dead process, whatever its parent and group', () => {
    const dead = `3737988       0 4294967295 ${fakeUid} X+ ${padStart(FAKE_START)}`;
    const table = readPiPsTable(fakePs([dead, fakeRow(4242, 4242), parentRow()]));
    expect([...table.keys()]).toEqual([4242, FAKE_PARENT]);
    const kill = vi.fn();
    expect(
      signalPiBashGroup(recordedPs(), 'SIGKILL', {
        ...fakePs([dead, fakeRow(4242, 4242), parentRow()]),
        kill,
      })
    ).toMatchObject({ sent: true, verification: { ok: true, members: 1 } });
  });

  it.each([
    ['a dead process with a group beyond 32 bits', `5 0 4294967296 ${fakeUid} X ${FAKE_START}`],
    ['a live process with the group -1', `5 0 4294967295 ${fakeUid} S ${FAKE_START}`],
    ['a dead process with a cut-off lstart', `5 0 4294967295 ${fakeUid} X Wed Nov 4`],
  ])('takes %s for a table not read', (_name, text) => {
    expect(unknown([text, fakeRow(4242, 4242), parentRow()])).toMatchObject({
      sent: false,
      verification: { reason: 'inspection_failed', error: 'malformed' },
    });
  });

  it('accepts what ps prints for the kernel and its threads (PID 0, group 0)', () => {
    const table = readPiPsTable(
      fakePs([
        `    0     0     0     0 Ss   ${padStart(FAKE_START)}`,
        `2 0 0 0 S< ${FAKE_START}`,
        fakeRow(4242, 4242, 'R+'),
      ])
    );
    expect([...table.keys()]).toEqual([0, 2, 4242]);
  });

  // C12: the locale and time zone are `ps`'s own, whatever the caller's.
  it('runs ps in the C locale and UTC whatever the environment', () => {
    vi.stubEnv('LC_ALL', 'pl_PL.UTF-8');
    vi.stubEnv('TZ', 'Pacific/Honolulu');
    try {
      const script = path.join(dir, 'env-ps');
      const table = path.join(dir, 'env-table');
      fs.writeFileSync(table, `${fakeRow(4242, 4242)}\n${parentRow()}\n`);
      const one = path.join(dir, 'env-one');
      fs.writeFileSync(one, `${fakeCommand()}\n`);
      fs.writeFileSync(
        script,
        `#!/bin/sh\n[ "$LC_ALL" = C ] && [ "$TZ" = UTC ] || exit 9\nif [ "$1" = -A ]; then cat '${table}'; else cat '${one}'; fi\n`,
        { mode: 0o700 }
      );
      expect(
        verifyPiBashGroup(recordedPs(), { procRoot: path.join(dir, 'no-proc'), ps: script })
      ).toMatchObject({
        ok: true,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // C15: a `ps` that does not end is a failed inspection.
  it('leaves the group unknown when ps does not end in time', () => {
    const script = path.join(dir, 'hung-ps');
    fs.writeFileSync(script, '#!/bin/sh\nexec sleep 12\n', { mode: 0o700 });
    const kill = vi.fn();
    expect(
      signalPiBashGroup(recordedPs(), 'SIGKILL', {
        procRoot: path.join(dir, 'no-proc'),
        ps: script,
        kill,
      })
    ).toMatchObject({ sent: false, verification: { reason: 'inspection_failed' } });
    expect(kill).not.toHaveBeenCalled();
  }, 15_000);

  // C16: members of another user in a verified group change nothing, as with procfs.
  it('accepts a verified leader whatever the users of its members, as procfs does', () => {
    const kill = vi.fn();
    expect(signalPiBashGroup(group(), 'SIGKILL', { ...procWithMarker(), kill }).sent).toBe(true);
    expect(
      signalPiBashGroup(recordedPs(), 'SIGKILL', {
        ...fakePs([
          fakeRow(4242, 4242),
          fakeRow(4243, 4242, 'S', FAKE_START, fakeUid + 1),
          parentRow(),
        ]),
        kill,
      }).sent
    ).toBe(true);
    expect(kill.mock.calls).toEqual([
      [-4242, 'SIGKILL'],
      [-4242, 'SIGKILL'],
    ]);
  });
  const procWithMarker = () =>
    fakeProc({
      4242: { pgrp: 4242, sid: 4242, starttime: '1000', env: [`${PI_BASH_MARKER_ENV}=i1:t1`] },
    });
});

describe('round 11: one source per shell, a registry start only in its place (R11-C)', () => {
  // A07: a procfs with processes but no `self` is incomplete procfs, not absent.
  it('A07: keeps procfs that has processes but no self', () => {
    const root = path.join(dir, 'partial');
    fs.mkdirSync(path.join(root, '4242'), { recursive: true });
    const fields = ['S', '1', '4242', '4242'];
    while (fields.length < 19) fields.push('0');
    fields.push('1000', '0');
    fs.writeFileSync(path.join(root, '4242', 'stat'), `4242 (bash) ${fields.join(' ')}\n`);
    fs.writeFileSync(path.join(root, '4242', 'environ'), `${PI_BASH_MARKER_ENV}=i1:t1\0`);
    const options = { ...fakePs([fakeRow(4242, 4242), parentRow()]), procRoot: root };
    expect(piBashProcessView(options)).toBe('procfs');
    expect(verifyPiBashGroup(group(), options)).toMatchObject({
      ok: true,
      reason: 'leader_verified',
    });
    // Only an empty mount point, or one with neither `self` nor a process, is no procfs.
    const other = path.join(dir, 'not-proc');
    fs.mkdirSync(path.join(other, 'sys'), { recursive: true });
    expect(piBashProcessView({ procRoot: other, ps: 'ps' })).toBe('ps');
  });

  const spawnLine = (extra: Record<string, unknown> = {}) =>
    line({
      event: 'spawn',
      toolCallId: 't1',
      marker: 'm',
      pid: 10,
      pgid: 10,
      starttime: null,
      ppid: 9,
      args: 'a'.repeat(64),
      ...extra,
    });
  const startsLine = (extra: Record<string, unknown> = {}) =>
    line({
      event: 'lstart',
      toolCallId: 't1',
      pid: 10,
      lstart: ' Wed Nov  4 09:10:58 2026',
      plstart: 'Wed Nov 4 09:00:00 2026',
      ...extra,
    });

  it('folds the starts the bridge read into the group', () => {
    expect(parsePiBashRegistry([spawnLine(), startsLine()].join('\n'))).toMatchObject({
      groups: [
        {
          pid: 10,
          ppid: 9,
          args: 'a'.repeat(64),
          lstart: 'Wed Nov 4 09:10:58 2026',
          parentLstart: 'Wed Nov 4 09:00:00 2026',
        },
      ],
      invalidLines: 0,
    });
  });

  it.each([
    ['before the spawn', [startsLine(), spawnLine()]],
    [
      'after the exit',
      [spawnLine(), line({ event: 'exit', toolCallId: 't1', pid: 10 }), startsLine()],
    ],
    ['for another PID', [spawnLine(), startsLine({ pid: 11 })]],
    ['with a non-date', [spawnLine(), startsLine({ lstart: 'unavailable' })]],
    ['without the parent start', [spawnLine(), startsLine({ plstart: undefined })]],
    ['with a non-date parent start', [spawnLine(), startsLine({ plstart: 'unavailable' })]],
    ['twice (neither is trusted)', [spawnLine(), startsLine(), startsLine()]],
    ['three times (none is trusted)', [spawnLine(), startsLine(), startsLine(), startsLine()]],
    [
      'next to a start in the spawn',
      [spawnLine({ lstart: 'Wed Nov 4 09:10:58 2026' }), startsLine()],
    ],
  ])('trusts no starts recorded %s', (_name, lines) => {
    const registry = parsePiBashRegistry(lines.join('\n'));
    expect(registry.invalidLines).toBeGreaterThan(0);
    expect(registry.groups).toHaveLength(1);
    expect(registry.groups[0]).not.toHaveProperty('parentLstart');
    expect(registry.groups[0]).not.toHaveProperty('lstart');
  });

  it.each([
    ['a ppid that is no PID', { ppid: 1 }, 'ppid'],
    ['a ppid that is no number', { ppid: '9' }, 'ppid'],
    ['a fingerprint that is not one', { args: 'xyz' }, 'args'],
  ])('keeps no %s from the spawn', (_name, extra, field) => {
    const [g] = parsePiBashRegistry(spawnLine(extra)).groups;
    expect(g).not.toHaveProperty(field);
  });
});

// Joint round 3 of stages 2 and 5 (`p1_joint_fix3_brief.md`, D-18 A): the attacks of round 12 of
// both recheck legs (Codex `codex-r12/r12.attack.test.ts` A03–A04, C01–C11; Sonnet
// `attack-s2nn.test.ts`, `attack-s2nn-b.test.ts`), kept as regressions, and the checks of the
// label. Synthetic PIDs are only ever "signalled" through a `kill` spy. Sonnet's two tests modelled
// a registry with no `exit` for a PID the bridge had reaped (the window `bridge.ts` closed by
// writing `exit` as the shell is reaped); they stay as such: the label decides even then.
describe('joint round 3: the label decides on the ps path (D-18; R12-A, R12-B, R12-D)', () => {
  const OTHER_LABEL = 'fedcba9876543210fedcba9876543210';
  const signalled = (record: PiBashGroup, options: ReturnType<typeof fakePs>) => {
    const kill = vi.fn();
    const result = signalPiBashGroup(record, 'SIGKILL', { ...options, kill });
    return { result, kill };
  };

  // R12-B (Codex A03, A04): a PID twice, the first row dead (`X`), is a table not read.
  it.each([
    ['A03: X, then a live row', [fakeRow(4242, 4242, 'X'), fakeRow(4242, 4242), parentRow()]],
    ['A04: X twice', [fakeRow(4242, 4242, 'X'), fakeRow(4242, 4242, 'X'), parentRow()]],
    ['a live row, then X', [fakeRow(4242, 4242), fakeRow(4242, 4242, 'X'), parentRow()]],
  ])('R12-B %s: inspection_failed, nothing sent', (_name, rows) => {
    const { result, kill } = signalled(recordedPs(), fakePs(rows));
    expect(result).toMatchObject({
      sent: false,
      verification: { ok: false, reason: 'inspection_failed', error: 'malformed' },
    });
    expect(kill).not.toHaveBeenCalled();
  });

  // Codex C01–C08: what a dead row, a state and a table not whole decide, with the label.
  it.each([
    ['C01', [fakeRow(4242, 4242, 'X'), fakeRow(4243, 4242), parentRow()], 'members_unverifiable'],
    ['C02', [fakeRow(4242, 4242, 'SX'), parentRow()], 'leader_verified'],
    ['C03', [fakeRow(4242, 4242, 'X'), parentRow()], 'group_empty'],
    ['C04', [fakeRow(4242, 4294967295), parentRow()], 'inspection_failed'],
    ['C05', [fakeRow(4242, 4242), fakeRow(4242, 4242), parentRow()], 'inspection_failed'],
    ['C06', [`4242 4000 4242 ${fakeUid} S Wed Nov 4`, parentRow()], 'inspection_failed'],
    ['C07', [fakeRow(4242, 4242, 'Sq'), parentRow()], 'inspection_failed'],
    ['C08', [fakeRow(4242, 4242, 'X'), fakeRow(4243, 4242, 'Z'), parentRow()], 'group_empty'],
  ])('%s', (_id, rows, reason) => {
    expect(verifyPiBashGroup(recordedPs(), fakePs(rows)).reason).toBe(reason);
  });

  // Codex C09–C11: a command line read that fails or shows another process.
  it.each([
    ['C09: another parent', fakeCommand(4242, 4001), 0],
    ['C10: ps fails', fakeCommand(), 1],
    ['C11: a cut-off date', '4242 4000 Wed Nov 4', 0],
  ])('%s: inspection_failed, nothing sent', (_name, command, exit) => {
    const { result, kill } = signalled(
      recordedPs(),
      fakePs([fakeRow(4242, 4242), parentRow()], exit, command)
    );
    expect(result).toMatchObject({ sent: false, verification: { reason: 'inspection_failed' } });
    expect(kill).not.toHaveBeenCalled();
  });

  // R12-D (Sonnet S2-NN, S2-NN-b): another live shell of the same bridge got the PID in the same
  // second (same parent and its start, same `lstart`, the same fingerprint: stdin transport, or the
  // same command line). Its label is its own: refused, nothing sent.
  it.each([
    ['stdin transport', ['/bin/bash', '-s']],
    ['the same command line (argv transport)', ['/bin/bash', '-c', 'git status', '/bin/bash']],
  ])('R12-D: refuses a sibling shell with the same %s and another label', (_name, argv) => {
    const own = [...argv, FAKE_LABEL];
    const sibling = [...argv, OTHER_LABEL];
    const recordA = recordedPs({
      args: piBashArgsFingerprint(own),
      psArgs: piBashPsArgsDigest(own.join(' ')),
    });
    const command = (args: string[]) => fakeCommand(4242, FAKE_PARENT, FAKE_START, args.join(' '));
    const rows = [fakeRow(4242, 4242), parentRow()];
    // Without the labels the two command lines are one (what R11-A compared); the label differs.
    expect(sibling.slice(0, -1)).toEqual(own.slice(0, -1));
    const { result, kill } = signalled(recordA, fakePs(rows, 0, command(sibling)));
    expect(result).toMatchObject({
      sent: false,
      verification: { ok: false, reason: 'leader_command_mismatch' },
    });
    expect(kill).not.toHaveBeenCalled();
    // Control: the recorded shell itself.
    expect(verifyPiBashGroup(recordA, fakePs(rows, 0, command(own)))).toMatchObject({
      ok: true,
      reason: 'leader_verified',
    });
  });

  // R12-A: any change of the command line is refused, also one the fingerprint leaves out (` #`)
  // or one that keeps the label only inside another word.
  it.each([
    ['a ` #` appended (fingerprint and label unchanged)', `${FAKE_ARGV.join(' ')} #`],
    ['` #` inside the command', '/bin/bash -c sleep 30; true # /bin/bash ' + FAKE_LABEL],
    ['no label', '/bin/bash -c sleep 30; true /bin/bash'],
    ['the label inside another word', `/bin/bash -c sleep 30; true /bin/bash x${FAKE_LABEL}`],
    ['another label', `/bin/bash -c sleep 30; true /bin/bash ${OTHER_LABEL}`],
  ])('R12-A: refuses a leader with %s', (_name, args) => {
    const { result, kill } = signalled(
      recordedPs(),
      fakePs(
        [fakeRow(4242, 4242), parentRow()],
        0,
        fakeCommand(4242, FAKE_PARENT, FAKE_START, args)
      )
    );
    expect(result).toMatchObject({
      sent: false,
      verification: { ok: false, reason: 'leader_command_mismatch' },
    });
    expect(kill).not.toHaveBeenCalled();
  });

  // The label decides by itself: a digest recorded for a command line without it (no bridge writes
  // one, `bridge.ts` records `cmd` only with the label in it) does not make the leader the shell.
  it('refuses a leader without its label even when the recorded digest matches its command line', () => {
    const args = '/bin/bash -c sleep 30; true /bin/bash';
    const { result, kill } = signalled(
      recordedPs({ psArgs: piBashPsArgsDigest(args), args: piBashArgsFingerprint(args) }),
      fakePs(
        [fakeRow(4242, 4242), parentRow()],
        0,
        fakeCommand(4242, FAKE_PARENT, FAKE_START, args)
      )
    );
    expect(result).toMatchObject({
      sent: false,
      verification: { ok: false, reason: 'leader_command_mismatch' },
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it.each([
    ['no label recorded (a registry from before D-18)', { label: undefined }],
    ['no command line read with the label recorded', { psArgs: undefined }],
  ])('refuses a leader with %s', (_name, extra) => {
    const { result, kill } = signalled(
      recordedPs(extra),
      fakePs([fakeRow(4242, 4242), parentRow()])
    );
    expect(result).toMatchObject({
      sent: false,
      verification: { ok: false, reason: 'leader_command_mismatch' },
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it('folds the label of the intent and the spawn, and the digest of the starts', () => {
    const digest = 'b'.repeat(64);
    const lines = [
      line({ event: 'intent', toolCallId: 't1', marker: 'm', label: FAKE_LABEL }),
      line({ event: 'intent', toolCallId: 't2', marker: 'm2', label: FAKE_LABEL }),
      line({
        event: 'spawn',
        toolCallId: 't1',
        marker: 'm',
        pid: 10,
        pgid: 10,
        starttime: null,
        label: FAKE_LABEL,
      }),
      line({
        event: 'lstart',
        toolCallId: 't1',
        pid: 10,
        lstart: FAKE_START,
        plstart: FAKE_PARENT_START,
        cmd: digest,
      }),
    ];
    const registry = parsePiBashRegistry(lines.join('\n'));
    expect(registry.groups[0]).toMatchObject({ label: FAKE_LABEL, psArgs: digest });
    expect(registry.unspawned).toEqual([
      { instance: 'i1', toolCallId: 't2', run: 0, marker: 'm2', label: FAKE_LABEL },
    ]);
    expect(registry.invalidLines).toBe(0);
  });

  it.each([
    ['a spawn label that contradicts the intent', [OTHER_LABEL, FAKE_LABEL], 'label'],
    ['a label that is not one', ['XYZ', 'XYZ'], 'label'],
  ])('keeps no label for %s', (_name, [intent, spawned], field) => {
    const lines = [
      line({ event: 'intent', toolCallId: 't1', marker: 'm', label: intent }),
      line({ event: 'spawn', toolCallId: 't1', marker: 'm', pid: 10, pgid: 10, label: spawned }),
    ];
    expect(parsePiBashRegistry(lines.join('\n')).groups[0]).not.toHaveProperty(field as string);
  });

  it.each([
    ['a digest that is not one', [{ cmd: 'xyz' }]],
    ['a second starts record', [{ cmd: 'b'.repeat(64) }, { cmd: 'c'.repeat(64) }]],
  ])('trusts no command line digest with %s', (_name, extras) => {
    const lines = [
      line({ event: 'spawn', toolCallId: 't1', marker: 'm', pid: 10, pgid: 10, label: FAKE_LABEL }),
      ...extras.map((extra) =>
        line({
          event: 'lstart',
          toolCallId: 't1',
          pid: 10,
          lstart: FAKE_START,
          plstart: FAKE_PARENT_START,
          ...extra,
        })
      ),
    ];
    const registry = parsePiBashRegistry(lines.join('\n'));
    expect(registry.invalidLines).toBeGreaterThan(0);
    expect(registry.groups[0]).not.toHaveProperty('psArgs');
    expect(registry.groups[0]).not.toHaveProperty('lstart');
  });

  /** A `ps` that prints `rows` (`pid stat args`), as for `readPiPsLabelled`. */
  function labelPs(rows: string[], exit = 0) {
    const file = path.join(dir, `label-ps-${Math.random().toString(36).slice(2)}`);
    const table = `${file}.out`;
    fs.writeFileSync(table, rows.map((text) => `${text}\n`).join(''));
    fs.writeFileSync(file, `#!/bin/sh\ncat '${table}'\nexit ${exit}\n`, { mode: 0o700 });
    return { ps: file };
  }

  it('finds the live processes that carry a label as a word, nothing else', () => {
    const found = readPiPsLabelled(
      [FAKE_LABEL, OTHER_LABEL],
      labelPs([
        `   10 Ss   /bin/bash -c sleep 30 /bin/bash ${FAKE_LABEL}`,
        `   11 Z    [bash] ${FAKE_LABEL}`,
        `   12 S    grep x${FAKE_LABEL}`,
        `   13 S+   tool ${FAKE_LABEL} --watch`,
        '   14 R    ps -A -ww -o pid=,stat=,args=',
        '   15 S',
      ])
    );
    expect(found).toEqual(
      new Map([
        [FAKE_LABEL, [10, 13]],
        [OTHER_LABEL, []],
      ])
    );
  });

  it.each([
    ['a line that is not a row', ['   10 Ss /bin/bash', 'garbage line']],
    ['a state ps does not print', [`   10 Qq /bin/bash ${FAKE_LABEL}`]],
    ['nothing', []],
  ])('finds nothing it can trust in %s: it throws', (_name, rows) => {
    expect(() => readPiPsLabelled([FAKE_LABEL], labelPs(rows))).toThrow(PiProcInspectionError);
  });

  it('throws when ps fails', () => {
    expect(() => readPiPsLabelled([FAKE_LABEL], labelPs([`10 S x ${FAKE_LABEL}`], 1))).toThrow(
      PiProcInspectionError
    );
  });
});

// R7-C (brief 1.6): the one rule of where processes are read, for every kind of root.
describe('joint round 3: piProcSource, the one rule of where processes are read (R7-C)', () => {
  const failing = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };
  const listing = (names: string[]) => () => names;
  it.each([
    ['absent (ENOENT)', '/x', false, failing('ENOENT'), { source: 'ps', root: 'absent' }],
    ['absent (ENOTDIR)', '/x', true, failing('ENOTDIR'), { source: 'ps', root: 'absent' }],
    ['the system root absent', '/proc', false, failing('ENOENT'), { source: 'ps', root: 'absent' }],
    ['unreadable', '/x', false, failing('EACCES'), { source: 'procfs', root: 'unreadable' }],
    ['complete', '/x', false, listing(['self', '1']), { source: 'procfs', root: 'complete' }],
    ['only self', '/x', false, listing(['self']), { source: 'procfs', root: 'complete' }],
    ['no self, a pid', '/x', false, listing(['4242']), { source: 'procfs', root: 'incomplete' }],
    [
      'no self, a pid, ps given',
      '/x',
      true,
      listing(['4242']),
      { source: 'procfs', root: 'incomplete' },
    ],
    ['the system root empty', '/proc', false, listing([]), { source: 'ps', root: 'empty' }],
    [
      'the system root, no process',
      '/proc',
      false,
      listing(['sys']),
      { source: 'ps', root: 'empty' },
    ],
    ['a custom root empty, ps given', '/x', true, listing([]), { source: 'ps', root: 'empty' }],
    ['a custom root empty, no ps', '/x', false, listing([]), { source: 'none', root: 'empty' }],
    [
      'a custom root of no process, no ps',
      '/x',
      false,
      listing(['sys']),
      { source: 'none', root: 'empty' },
    ],
  ] as const)('%s', (_name, root, psGiven, list, expected) => {
    expect(piProcSource(root, psGiven, list)).toEqual(expected);
  });

  it('is what piBashProcessView and verifyPiBashGroup decide by', () => {
    const empty = path.join(dir, 'empty-root');
    fs.mkdirSync(empty);
    expect(piBashProcessView({ procRoot: empty, ps: 'ps' })).toBe('ps');
    expect(piBashProcessView({ procRoot: empty })).toBe('procfs');
    expect(verifyPiBashGroup(group(), { procRoot: empty })).toMatchObject({
      reason: 'inspection_failed',
      error: 'no_source',
    });
    // Codex A12 on this side: never `group_empty` from a directory that shows nothing.
    const kill = vi.fn();
    expect(signalPiBashGroup(group(), 'SIGKILL', { procRoot: empty, kill }).sent).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});
