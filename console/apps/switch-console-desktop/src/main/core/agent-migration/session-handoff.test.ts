import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function state(...parts: string[]): string {
  return join(home, '.local', 'state', 'switch', ...parts);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function session(id: string, credentialsPath: string, agentId = AGENT): string {
  const root = state('sdk-sessions', hash(id));
  writeJson(join(root, 'config.json'), {
    session: { sessionId: id, agentId },
    start: { provider: 'claude', input: { cwd: '/work' } },
    execution: { credentialsPath, inheritEnv: [] },
  });
  return root;
}

function credentialsOf(id: string): unknown {
  const config = readJson(join(state('sdk-sessions', hash(id)), 'config.json'));
  return (config.execution as { credentialsPath: string }).credentialsPath;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'handoff-home-'));
  run = async (script, args) =>
    (
      await execute(process.execPath, ['-e', script, ...args], {
        env: { ...process.env, HOME: home },
      })
    ).stdout;
  identity = {
    switchAgentId: AGENT,
    controllerRoot: '~/controller/watchers/switch-agent-1',
    controllerCredentials: '~/controller/agents/switch-agent-1/credentials.json',
    consoleCredentials: '/work/.switch/agents/builder.json',
  };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('handing an agent’s sessions over to its controller', () => {
  it('moves which session attends which room, and points its sessions at the relay', async () => {
    writeJson(join(state('sdk-watchers', hash(AGENT)), 'config.json'), {
      session: { agentId: AGENT },
    });
    writeJson(join(state('sdk-watchers', hash(AGENT)), 'placements.json'), {
      placements: { 'session-1': 'room-1' },
    });
    session('session-1', identity.consoleCredentials);
    session('session-2', identity.consoleCredentials);
    session('other-agent', '/elsewhere/.switch/agents/x.json', 'switch-agent-2');

    const result = await runHandoff(run, { op: 'hand-over', identities: [identity] });

    expect(result.placements).toEqual([{ switchAgentId: AGENT, rooms: 1 }]);
    expect(result.rewritten.sort()).toEqual(['session-1', 'session-2']);
    expect(result.live).toEqual([]);
    expect(readJson(join(home, 'controller', 'watchers', AGENT, 'placements.json'))).toEqual({
      placements: { 'session-1': 'room-1' },
    });
    const relay = join(home, 'controller', 'agents', AGENT, 'credentials.json');
    expect(credentialsOf('session-1')).toBe(relay);
    expect(credentialsOf('other-agent')).toBe('/elsewhere/.switch/agents/x.json');
  });

  it('leaves a running session as it is, and says so', async () => {
    const root = session('session-1', identity.consoleCredentials);
    writeJson(join(root, 'supervisor', 'owner.json'), { pid: process.pid });

    const result = await runHandoff(run, { op: 'hand-over', identities: [identity] });

    expect(result.live).toEqual(['session-1']);
    expect(credentialsOf('session-1')).toBe(identity.consoleCredentials);
  });

  it('refuses while a watcher still runs', async () => {
    writeJson(join(home, 'controller', 'watchers', AGENT, 'shared-owner.lock'), {
      pid: process.pid,
    });
    await expect(runHandoff(run, { op: 'hand-over', identities: [identity] })).rejects.toThrow(
      /still running/
    );
  });

  it('drops placements a controller root kept from an earlier stay', async () => {
    writeJson(join(home, 'controller', 'watchers', AGENT, 'placements.json'), {
      placements: { stale: 'room-9' },
    });
    await runHandoff(run, { op: 'hand-over', identities: [identity] });
    expect(() => readJson(join(home, 'controller', 'watchers', AGENT, 'placements.json'))).toThrow(
      /ENOENT/
    );
  });
});

describe('handing them back', () => {
  it('restores the rooms and the agent’s own credentials file', async () => {
    const relay = join(home, 'controller', 'agents', AGENT, 'credentials.json');
    session('session-1', relay);
    writeJson(join(home, 'controller', 'watchers', AGENT, 'placements.json'), {
      placements: { 'session-1': 'room-2' },
    });

    const result = await runHandoff(run, { op: 'hand-back', identities: [identity] });

    expect(result.rewritten).toEqual(['session-1']);
    expect(credentialsOf('session-1')).toBe(identity.consoleCredentials);
    expect(readJson(join(state('sdk-watchers', hash(AGENT)), 'placements.json'))).toEqual({
      placements: { 'session-1': 'room-2' },
    });
  });
});

describe('the watchers', () => {
  it('reports which side is running', async () => {
    writeJson(join(home, 'controller', 'watchers', AGENT, 'supervisor', 'owner.json'), {
      pid: process.pid,
    });
    const result = await runHandoff(run, { op: 'status', identities: [identity] });
    expect(result.watchers).toEqual([{ switchAgentId: AGENT, console: false, controller: true }]);
  });

  it('turns the controller’s watcher off when asked', async () => {
    mkdirSync(join(home, 'controller', 'watchers', AGENT), { recursive: true });
    await runHandoff(run, { op: 'turn-off', identities: [identity] });
    expect(readJson(join(home, 'controller', 'watchers', AGENT, 'watch.json'))).toEqual({
      enabled: false,
      spawn: false,
    });
  });
});
