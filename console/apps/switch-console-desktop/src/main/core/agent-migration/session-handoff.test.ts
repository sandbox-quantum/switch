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

describe('starting an agent afresh on one side', () => {
  it.each([
    ['the controller', 'controller' as const, controllerRoot, consoleRoot],
    ['Console', 'console' as const, consoleRoot, controllerRoot],
  ])(
    'on %s clears its room placements and moves its stream to the head, leaving the other side alone',
    async (_what, side, ours, other) => {
      writeJson(join(ours(), 'placements.json'), { placements: { stale: 'room-9' } });
      writeJson(join(other(), 'placements.json'), { placements: { kept: 'room-1' } });
      writeFileSync(join(ours(), 'assignments.jsonl'), `${JSON.stringify({ handled: 42 })}\n`);

      await runHandoff(run, { op: 'start-fresh', side, identities: [identity] });

      expect(existsSync(join(ours(), 'placements.json'))).toBe(false);
      expect(existsSync(join(other(), 'placements.json'))).toBe(true);
      expect(journal(ours()).at(-1)).toMatchObject({ restarted: true });
    }
  );

  it('refuses while that side’s watcher is running', async () => {
    writeJson(join(controllerRoot(), 'supervisor', 'owner.json'), { pid: process.pid });
    await expect(
      runHandoff(run, { op: 'start-fresh', side: 'controller', identities: [identity] })
    ).rejects.toThrow(/still running/);
  });

  it('does nothing where the agent never ran', async () => {
    await runHandoff(run, { op: 'start-fresh', side: 'controller', identities: [identity] });
    expect(existsSync(controllerRoot())).toBe(false);
  });
});

describe('turning the controller’s watcher off', () => {
  it('writes it disabled where it ran', async () => {
    writeJson(join(controllerRoot(), 'config.json'), {});
    await runHandoff(run, { op: 'turn-off', identities: [identity] });
    expect(JSON.parse(readFileSync(join(controllerRoot(), 'watch.json'), 'utf8'))).toEqual({
      enabled: false,
      spawn: false,
    });
  });
});
