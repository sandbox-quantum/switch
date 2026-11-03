import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PI_BASH_MARKER_ENV,
  parsePiBashRegistry,
  PiProcInspectionError,
  piProcessGroupMembers,
  readPiBashRegistry,
  readPiProcStat,
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
    expect(verifyPiBashGroup(group(), missing)).toEqual({
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

async function startGroup(env: Record<string, string>, script = 'sleep 30; true') {
  const child = spawn('/bin/bash', ['-c', script], {
    detached: true,
    stdio: 'ignore',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
  });
  const pid = child.pid as number;
  spawned.push(pid);
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
