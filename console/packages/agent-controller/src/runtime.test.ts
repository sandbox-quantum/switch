import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { type OpenAgentStream, readSharedCredentials } from '@switch-console/agent-providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from './log';
import { dataLayout } from './paths';
import { InProcessRuntime, isInside, observeOnDisk } from './runtime';
import { buildWatcherTemplate } from './template';

/** Stands in for the shared-host bundle: answers `--probe`. Sessions are never started here. */
const FAKE_BUNDLE = `
const args = process.argv.slice(2);
if (args[0] === '--probe') {
  console.log('noise first');
  console.log(JSON.stringify({ status: 'authenticated', message: args.join(' '), models: [] }));
}
`;

const RELAY = {
  endpoint: 'http://127.0.0.1:43210',
  token: 'swlr_relay-token-placeholder',
  hub: 'ws://127.0.0.1:43210/hub',
};
const LAUNCH = {
  isolation: 'shared' as const,
  restart: false,
  replaceIdentity: false,
  clearTakenOver: false,
};

let dir: string;
let bundle: string;
let runtime: InProcessRuntime;
let home: string | undefined;
let opened: { agentId: string; scope: string; filter: string; signal: AbortSignal }[];
let attempts: number;
let failOpens: number;
const children: ChildProcess[] = [];

/** The controller's end of each watcher's stream: it records the open and never delivers anything. */
function openStream(agentId: string): OpenAgentStream {
  return (deps) => {
    attempts++;
    if (failOpens > 0) {
      failOpens--;
      throw new Error('stream refused');
    }
    opened.push({ agentId, scope: deps.scope, filter: deps.filter, signal: deps.signal });
    return {
      announcesSessionStarts: true,
      start: () => {},
      setSpawnCapable: () => {},
      replacePlacements: async () => {},
      workerCall: () => Promise.reject(new Error('not a worker')),
    };
  };
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await delay(10);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controller-runtime-'));
  home = process.env.HOME;
  process.env.HOME = join(dir, 'home');
  bundle = join(dir, 'fake-bundle.cjs');
  writeFileSync(bundle, FAKE_BUNDLE);
  opened = [];
  attempts = 0;
  failOpens = 0;
  runtime = new InProcessRuntime({
    layout: dataLayout(join(dir, 'data')),
    workspaces: join(dir, 'data', 'workspaces'),
    bundlePath: bundle,
    openStream,
    log: silentLogger,
    crashBackoffMs: 5,
  });
});

afterEach(async () => {
  await runtime.close();
  for (const child of children) child.kill('SIGKILL');
  children.length = 0;
  process.env.HOME = home;
  rmSync(dir, { recursive: true, force: true });
});

function template(cwd = '/work/scout', provider: 'claude' | 'codex' = 'claude') {
  return buildWatcherTemplate({
    agentId: 'agent-1',
    provider,
    definition: {
      name: 'scout',
      model: null,
      advanced_config: {},
      instructions: '',
      auto_approve: false,
    },
    cwd,
    credentialsPath: runtime.credentialsPath('agent-1'),
    binaryPath: null,
  });
}

/** A process whose command line names the watcher root, as a detached watcher's does. */
async function fakeWatcher(root: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', root], {
    stdio: 'ignore',
  });
  children.push(child);
  await once(child, 'spawn');
  return child;
}

describe('InProcessRuntime', () => {
  it('writes credentials the shared host reads, owner-only, outside the working directory', async () => {
    await runtime.writeCredentials('agent-1', RELAY);
    const path = runtime.credentialsPath('agent-1');
    expect(path).toBe(join(dir, 'data', 'agents', 'agent-1', 'credentials.json'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'data', 'agents', 'agent-1')).mode & 0o777).toBe(0o700);
    expect(await readSharedCredentials(template())).toEqual({
      SWITCH_API_ENDPOINT: 'http://127.0.0.1:43210',
      SWITCH_API_TOKEN: 'swlr_relay-token-placeholder',
      SWITCH_AGENT_ID: 'agent-1',
      SWITCH_AGENT_HUB: 'ws://127.0.0.1:43210/hub',
    });
    expect(await runtime.readCredentials('agent-1')).toEqual(RELAY);
    await runtime.deleteCredentials('agent-1');
    await runtime.deleteCredentials('agent-1');
    expect(await runtime.readCredentials('agent-1')).toBeNull();
  });

  it('runs the watcher in this process, from a template written as its configuration', async () => {
    await runtime.writeCredentials('agent-1', RELAY);
    await runtime.launch('agent-1', template(), LAUNCH);
    const root = join(dir, 'data', 'watchers', 'agent-1');
    expect(JSON.parse(readFileSync(join(root, 'watch.json'), 'utf8'))).toEqual({
      enabled: true,
      spawn: true,
    });
    await waitFor(() => opened.length === 1, 'the watcher to open its stream');
    expect(opened[0]).toMatchObject({ agentId: 'agent-1', scope: 'all', filter: 'addressed' });
    const observation = await runtime.observe('agent-1');
    expect(observation).toMatchObject({
      alive: true,
      configured: { provider: 'claude', cwd: '/work/scout' },
      flags: { enabled: true, spawn: true },
      failure: null,
      takenOver: null,
    });
    expect(observation.health).toMatchObject({ pid: process.pid, current: true });
    await waitFor(
      () => existsSync(join(dir, 'data', 'watchers', 'agent-1', 'health.json')),
      'the health file'
    );
    expect(await observeOnDisk(dataLayout(join(dir, 'data')), 'agent-1')).toMatchObject({
      alive: true,
      health: { pid: process.pid, current: true },
    });

    await runtime.stop('agent-1', { wait: true });
    expect(await runtime.observe('agent-1')).toMatchObject({
      alive: false,
      flags: { enabled: false, spawn: false },
      health: null,
    });
    expect(opened[0]!.signal.aborted).toBe(true);
  });

  it('restarts into a new provider or directory, replacing the saved configuration', async () => {
    await runtime.writeCredentials('agent-1', RELAY);
    await runtime.launch('agent-1', template(), LAUNCH);
    await waitFor(() => opened.length === 1, 'the first watcher');
    await runtime.launch('agent-1', template('/work/elsewhere', 'codex'), {
      isolation: 'shared',
      restart: true,
      replaceIdentity: true,
      clearTakenOver: true,
    });
    await waitFor(() => opened.length === 2, 'the second watcher');
    expect(opened[0]!.signal.aborted).toBe(true);
    expect(await runtime.observe('agent-1')).toMatchObject({
      alive: true,
      configured: { provider: 'codex', cwd: '/work/elsewhere' },
    });
  });

  it('starts a failed watcher again, and records its failure once it keeps failing', async () => {
    await runtime.writeCredentials('agent-1', RELAY);
    failOpens = 10;
    await runtime.launch('agent-1', template(), LAUNCH);
    await waitFor(() => attempts === 4, 'four attempts');
    await waitFor(
      () => existsSync(join(dir, 'data', 'watchers', 'agent-1', 'supervisor', 'failure.json')),
      'the failure recorded'
    );
    const observation = await runtime.observe('agent-1');
    expect(observation.alive).toBe(false);
    expect(observation.failure).toMatch(/stream refused/);
    await delay(100);
    expect(attempts).toBe(4);
  });

  it('stops a watcher an earlier controller left running as a process of its own', async () => {
    const root = join(dir, 'data', 'watchers', 'agent-1');
    mkdirSync(join(root, 'supervisor'), { recursive: true });
    const detached = await fakeWatcher(root);
    writeFileSync(join(root, 'supervisor', 'owner.json'), JSON.stringify({ pid: detached.pid }));
    await runtime.writeCredentials('agent-1', RELAY);
    await runtime.launch('agent-1', template(), LAUNCH);
    expect(detached.exitCode !== null || detached.signalCode !== null).toBe(true);
    await waitFor(() => opened.length === 1, 'the watcher in this process');
  });

  it('stops every watcher when closed', async () => {
    await runtime.writeCredentials('agent-1', RELAY);
    await runtime.launch('agent-1', template(), LAUNCH);
    await waitFor(() => opened.length === 1, 'the watcher');
    await runtime.close();
    expect(opened[0]!.signal.aborted).toBe(true);
    expect((await runtime.observe('agent-1')).alive).toBe(false);
  });

  it('reads a recorded failure and a stand-down marker', async () => {
    const root = join(dir, 'data', 'watchers', 'agent-1');
    mkdirSync(join(root, 'supervisor'), { recursive: true });
    writeFileSync(join(root, 'supervisor', 'failure.json'), JSON.stringify({ message: 'boom' }));
    writeFileSync(
      join(root, 'taken-over.json'),
      JSON.stringify({ at: 'x', reason: 'y', connectionId: 'z' })
    );
    expect(await runtime.observe('agent-1')).toMatchObject({
      alive: false,
      failure: 'boom',
      takenOver: { reason: 'y' },
    });
  });

  it('probes a provider through the bundle', async () => {
    const readiness = await runtime.probe('claude', '/usr/bin/claude', '/tmp');
    expect(readiness).toEqual({
      status: 'authenticated',
      message: '--probe claude /tmp /usr/bin/claude',
      models: [],
    });
  });

  it('resolves working directories', async () => {
    expect(await runtime.workingDirectory('agent-1', 'scout', null)).toBe(
      join(dir, 'data', 'workspaces', 'scout')
    );
    expect(statSync(join(dir, 'data', 'workspaces', 'scout')).isDirectory()).toBe(true);
    expect(await runtime.workingDirectory('agent-1', 'scout', dir)).toBe(dir);
    await expect(
      runtime.workingDirectory('agent-1', 'scout', 'relative/dir')
    ).rejects.toMatchObject({
      reason: 'definition_invalid',
    });
    await expect(
      runtime.workingDirectory('agent-1', 'scout', join(dir, 'missing'))
    ).rejects.toMatchObject({
      reason: 'definition_invalid',
    });
    await expect(runtime.workingDirectory('agent-1', 'scout', bundle)).rejects.toMatchObject({
      reason: 'definition_invalid',
    });
  });

  it('makes a missing directory inside the workspaces directory, and only there', async () => {
    const named = join(dir, 'data', 'workspaces', 'chosen', 'nested');
    expect(await runtime.workingDirectory('agent-1', 'scout', named)).toBe(named);
    expect(statSync(named).isDirectory()).toBe(true);
    const escaping = join(dir, 'data', 'workspaces', '..', 'outside');
    await expect(runtime.workingDirectory('agent-1', 'scout', escaping)).rejects.toMatchObject({
      reason: 'definition_invalid',
    });
    expect(existsSync(join(dir, 'data', 'outside'))).toBe(false);
    await expect(
      runtime.workingDirectory('agent-1', 'scout', join(dir, 'data', 'workspaces'))
    ).resolves.toBe(join(dir, 'data', 'workspaces'));
  });
});

describe('isInside', () => {
  it('is true strictly below the root', () => {
    expect(isInside('/data/workspaces', '/data/workspaces/scout')).toBe(true);
    expect(isInside('/data/workspaces', '/data/workspaces/a/b')).toBe(true);
    expect(isInside('/data/workspaces', '/data/workspaces')).toBe(false);
    expect(isInside('/data/workspaces', '/data/workspaces/../x')).toBe(false);
    expect(isInside('/data/workspaces', '/data/workspaces-other/x')).toBe(false);
    expect(isInside('/data/workspaces', '/data/workspaces/..scout')).toBe(true);
  });
});
