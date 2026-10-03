import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type HandoffIdentity, type MachineScript, runHandoff } from './session-handoff';

const execute = promisify(execFile);
const AGENT = 'switch-agent-1';

let home: string;
let run: MachineScript;
let identity: HandoffIdentity;

function consoleRoot(): string {
  return join(
    home,
    '.local',
    'state',
    'switch',
    'sdk-watchers',
    createHash('sha256').update(AGENT).digest('hex')
  );
}

function controllerRoot(): string {
  return join(home, 'controller', 'watchers', AGENT);
}

function journal(root: string): unknown[] {
  return readFileSync(join(root, 'assignments.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'handoff-home-'));
  run = async (script, args) =>
    (
      await execute(process.execPath, ['-e', script, ...args], {
        env: { ...process.env, HOME: home },
      })
    ).stdout;
  identity = { switchAgentId: AGENT, controllerRoot: '~/controller/watchers/switch-agent-1' };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('the watchers of an agent on its machine', () => {
  it('says which side is running', async () => {
    writeJson(join(controllerRoot(), 'supervisor', 'owner.json'), { pid: process.pid });
    writeJson(join(consoleRoot(), 'config.json'), { session: { agentId: AGENT } });
    const result = await runHandoff(run, { op: 'status', identities: [identity] });
    expect(result.watchers).toEqual([{ switchAgentId: AGENT, console: false, controller: true }]);
  });

  it('reads an owner record whose process has gone as not running', async () => {
    writeJson(join(consoleRoot(), 'shared-owner.lock'), { pid: 2 ** 22 + 12345 });
    const result = await runHandoff(run, { op: 'status', identities: [identity] });
    expect(result.watchers[0]).toMatchObject({ console: false, controller: false });
  });
});

describe('starting the agent afresh on the controller', () => {
  it('clears the room placements an earlier stay left, and leaves Console’s alone', async () => {
    writeJson(join(controllerRoot(), 'placements.json'), { placements: { stale: 'room-9' } });
    writeJson(join(consoleRoot(), 'placements.json'), { placements: { kept: 'room-1' } });

    const result = await runHandoff(run, { op: 'fresh-start', identities: [identity] });

    expect(result.cleared).toEqual([AGENT]);
    expect(existsSync(join(controllerRoot(), 'placements.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(consoleRoot(), 'placements.json'), 'utf8'))).toEqual({
      placements: { kept: 'room-1' },
    });
  });

  it('marks a journal left from an earlier stay, so its old position is not resumed', async () => {
    mkdirSync(controllerRoot(), { recursive: true });
    writeFileSync(join(controllerRoot(), 'assignments.jsonl'), '{"handled":7}\n');
    await runHandoff(run, { op: 'fresh-start', identities: [identity] });
    const lines = journal(controllerRoot());
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ restarted: true });
  });

  it('has nothing to clear the first time', async () => {
    const result = await runHandoff(run, { op: 'fresh-start', identities: [identity] });
    expect(result.cleared).toEqual([]);
  });

  it('refuses while the controller already runs the agent', async () => {
    writeJson(join(controllerRoot(), 'shared-owner.lock'), { pid: process.pid });
    await expect(runHandoff(run, { op: 'fresh-start', identities: [identity] })).rejects.toThrow(
      /already running/
    );
  });
});

describe('coming back to Console', () => {
  it('goes on from the last message the controller routed, keeping Console’s rooms', async () => {
    writeJson(join(consoleRoot(), 'placements.json'), { placements: { kept: 'room-1' } });
    mkdirSync(consoleRoot(), { recursive: true });
    writeFileSync(join(consoleRoot(), 'assignments.jsonl'), '{"handled":3}\n');
    mkdirSync(controllerRoot(), { recursive: true });
    writeFileSync(
      join(controllerRoot(), 'assignments.jsonl'),
      '{"handled":2}\n{"restarted":true,"at":"x"}\n{"handled":5}\n{"handled":9}\n'
    );

    const result = await runHandoff(run, { op: 'come-back', identities: [identity] });

    expect(result.resumed).toEqual([{ switchAgentId: AGENT, cursor: 9 }]);
    const lines = journal(consoleRoot());
    expect(lines[0]).toEqual({ handled: 3 });
    expect(lines[1]).toMatchObject({ restarted: true });
    expect(lines[2]).toEqual({ handled: 9 });
    expect(JSON.parse(readFileSync(join(consoleRoot(), 'placements.json'), 'utf8'))).toEqual({
      placements: { kept: 'room-1' },
    });
  });

  it('reads the position the way the watcher does, from held and released deliveries', async () => {
    mkdirSync(controllerRoot(), { recursive: true });
    writeFileSync(
      join(controllerRoot(), 'assignments.jsonl'),
      [
        { sequence: 5, roomId: 'r', messageId: 'm5', config: {} },
        { parked: 5, roomId: 'r', messageId: 'm5', spawning: false },
        { released: { roomId: 'r', messageId: 'm5' } },
        { parked: 8, roomId: 'r', messageId: 'm8', spawning: false },
      ]
        .map((record) => `${JSON.stringify(record)}\n`)
        .join('')
    );
    const result = await runHandoff(run, { op: 'come-back', identities: [identity] });
    // m8 is still held, so the position stays behind it.
    expect(result.resumed).toEqual([{ switchAgentId: AGENT, cursor: 5 }]);
  });

  it('starts at the stream’s head when the controller routed nothing', async () => {
    const result = await runHandoff(run, { op: 'come-back', identities: [identity] });
    expect(result.resumed).toEqual([{ switchAgentId: AGENT, cursor: 0 }]);
    expect(journal(consoleRoot())).toEqual([expect.objectContaining({ restarted: true })]);
  });

  it('refuses a journal with an incomplete record', async () => {
    mkdirSync(consoleRoot(), { recursive: true });
    writeFileSync(join(consoleRoot(), 'assignments.jsonl'), '{"handled":3}');
    await expect(runHandoff(run, { op: 'come-back', identities: [identity] })).rejects.toThrow(
      /incomplete record/
    );
  });

  it('refuses while either watcher still runs', async () => {
    writeJson(join(consoleRoot(), 'shared-owner.lock'), { pid: process.pid });
    await expect(runHandoff(run, { op: 'come-back', identities: [identity] })).rejects.toThrow(
      /still running/
    );
  });
});

describe('turning the controller’s watcher off', () => {
  it('writes the flag its watcher stops on', async () => {
    mkdirSync(controllerRoot(), { recursive: true });
    await runHandoff(run, { op: 'turn-off', identities: [identity] });
    expect(JSON.parse(readFileSync(join(controllerRoot(), 'watch.json'), 'utf8'))).toEqual({
      enabled: false,
      spawn: false,
    });
  });

  it('creates nothing for an agent the controller never ran', async () => {
    await runHandoff(run, { op: 'turn-off', identities: [identity] });
    expect(existsSync(controllerRoot())).toBe(false);
  });
});
