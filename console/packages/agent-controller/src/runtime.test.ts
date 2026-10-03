import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSharedCredentials } from '@switch-console/agent-providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataLayout } from './paths';
import { SharedHostRuntime } from './runtime';
import { buildWatcherTemplate } from './template';

/**
 * Stands in for the shared-host bundle: answers `--probe`, and for a launch
 * records its arguments and saves the template as `config.json`, as the real
 * launcher does on first launch.
 */
const FAKE_BUNDLE = `
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--probe') {
  console.log('noise first');
  console.log(JSON.stringify({ status: 'authenticated', message: args.join(' '), models: [] }));
} else if (args[2] === '--ensure-watch') {
  fs.appendFileSync(path.join(args[0], 'launches.log'), JSON.stringify(args) + '\\n');
  const config = path.join(args[0], 'config.json');
  if (!fs.existsSync(config)) fs.copyFileSync(args[1], config);
  if (process.env.FAKE_BUNDLE_FAIL) { console.error('cannot launch'); process.exit(4); }
}
`;

let dir: string;
let bundle: string;
let runtime: SharedHostRuntime;
const children: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controller-runtime-'));
  bundle = join(dir, 'fake-bundle.cjs');
  writeFileSync(bundle, FAKE_BUNDLE);
  runtime = new SharedHostRuntime({ layout: dataLayout(join(dir, 'data')), bundlePath: bundle });
});

afterEach(() => {
  for (const child of children) child.kill('SIGKILL');
  children.length = 0;
  delete process.env.FAKE_BUNDLE_FAIL;
  rmSync(dir, { recursive: true, force: true });
});

function template(cwd = '/work/scout', provider: 'claude' | 'codex' = 'claude') {
  return buildWatcherTemplate({
    agentId: 'agent-1',
    provider,
    definition: { model: null, instructions: '', auto_approve: false },
    cwd,
    credentialsPath: runtime.credentialsPath('agent-1'),
    binaryPath: null,
  });
}

/** A process whose command line names the watcher root, and that exits when the watcher is turned off. */
async function fakeWatcher(root: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const fs=require('fs');setInterval(()=>{try{if(!JSON.parse(fs.readFileSync(process.argv[1]+'/watch.json','utf8')).enabled)process.exit(0)}catch{}},50)`,
      root,
    ],
    { stdio: 'ignore' }
  );
  children.push(child);
  await once(child, 'spawn');
  return child;
}

describe('SharedHostRuntime', () => {
  it('writes credentials the shared host reads, owner-only, outside the working directory', async () => {
    await runtime.writeCredentials('agent-1', {
      endpoint: 'http://127.0.0.1:43210',
      token: 'swlr_relay-token-placeholder',
    });
    const path = runtime.credentialsPath('agent-1');
    expect(path).toBe(join(dir, 'data', 'agents', 'agent-1', 'credentials.json'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'data', 'agents', 'agent-1')).mode & 0o777).toBe(0o700);
    expect(await readSharedCredentials(template())).toEqual({
      SWITCH_API_ENDPOINT: 'http://127.0.0.1:43210',
      SWITCH_API_TOKEN: 'swlr_relay-token-placeholder',
      SWITCH_AGENT_ID: 'agent-1',
    });
    expect(await runtime.readCredentials('agent-1')).toEqual({
      endpoint: 'http://127.0.0.1:43210',
      token: 'swlr_relay-token-placeholder',
    });
    await runtime.deleteCredentials('agent-1');
    await runtime.deleteCredentials('agent-1');
    expect(await runtime.readCredentials('agent-1')).toBeNull();
  });

  it('launches the watcher with --ensure-watch from a template beside watch.json', async () => {
    await runtime.launch('agent-1', template(), {
      spawn: false,
      restart: false,
      replaceIdentity: false,
      clearTakenOver: false,
    });
    const root = join(dir, 'data', 'watchers', 'agent-1');
    expect(JSON.parse(readFileSync(join(root, 'watch.json'), 'utf8'))).toEqual({
      enabled: true,
      spawn: false,
    });
    const launches = readFileSync(join(root, 'launches.log'), 'utf8').trim().split('\n');
    expect(JSON.parse(launches[0]!)).toEqual([
      root,
      join(root, 'template.json'),
      '--ensure-watch',
      'false',
    ]);
    expect(statSync(join(root, 'template.json')).mode & 0o777).toBe(0o600);
    expect(await runtime.observe('agent-1')).toMatchObject({
      alive: false,
      configured: { provider: 'claude', cwd: '/work/scout' },
      flags: { enabled: true, spawn: false },
      health: null,
      failure: null,
      takenOver: null,
    });
  });

  it('surfaces a launcher failure with its output', async () => {
    process.env.FAKE_BUNDLE_FAIL = '1';
    await expect(
      runtime.launch('agent-1', template(), {
        spawn: true,
        restart: false,
        replaceIdentity: false,
        clearTakenOver: false,
      })
    ).rejects.toThrow(/exit 4\): cannot launch/);
  });

  it('restarts by turning the watcher off, waiting it out, and launching again', async () => {
    const root = join(dir, 'data', 'watchers', 'agent-1');
    await runtime.launch('agent-1', template(), {
      spawn: true,
      restart: false,
      replaceIdentity: false,
      clearTakenOver: false,
    });
    const watcher = await fakeWatcher(root);
    mkdirSync(join(root, 'supervisor'), { recursive: true });
    writeFileSync(join(root, 'supervisor', 'owner.json'), JSON.stringify({ pid: watcher.pid }));
    writeFileSync(
      join(root, 'taken-over.json'),
      JSON.stringify({ at: 'x', reason: 'y', connectionId: 'z' })
    );
    expect((await runtime.observe('agent-1')).alive).toBe(true);
    await runtime.launch('agent-1', template('/work/elsewhere', 'codex'), {
      spawn: true,
      restart: true,
      replaceIdentity: true,
      clearTakenOver: true,
    });
    expect(watcher.exitCode).toBe(0);
    const observation = await runtime.observe('agent-1');
    expect(observation).toMatchObject({
      alive: false,
      configured: { provider: 'codex', cwd: '/work/elsewhere' },
      flags: { enabled: true, spawn: true },
      takenOver: null,
    });
  });

  it('reads health and failure files, and tells a live writer from a dead one', async () => {
    const root = join(dir, 'data', 'watchers', 'agent-1');
    mkdirSync(join(root, 'supervisor'), { recursive: true });
    writeFileSync(join(root, 'watch.json'), JSON.stringify({ enabled: true, spawn: true }));
    const watcher = await fakeWatcher(root);
    const healthFile = {
      state: 'connected',
      detail: null,
      since: '2026-01-01T00:00:00Z',
      placements: { 's-1': 'room-1' },
      pid: watcher.pid,
      updatedAt: '2026-01-01T00:00:00Z',
    };
    writeFileSync(join(root, 'health.json'), JSON.stringify(healthFile));
    writeFileSync(join(root, 'shared-owner.lock'), JSON.stringify({ pid: watcher.pid }));
    expect(await runtime.observe('agent-1')).toMatchObject({
      alive: true,
      health: { state: 'connected', current: true, placements: { 's-1': 'room-1' } },
    });
    await runtime.stop('agent-1', { wait: true });
    writeFileSync(
      join(root, 'supervisor', 'failure.json'),
      JSON.stringify({ message: 'Shared SDK host exited with code 1.' })
    );
    expect(await runtime.observe('agent-1')).toMatchObject({
      alive: false,
      flags: { enabled: false, spawn: false },
      health: { current: false },
      failure: 'Shared SDK host exited with code 1.',
    });
  });

  it('does not count a recorded PID that now names some other process', async () => {
    const root = join(dir, 'data', 'watchers', 'agent-1');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'shared-owner.lock'), JSON.stringify({ pid: process.pid }));
    expect((await runtime.observe('agent-1')).alive).toBe(false);
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
    expect(await runtime.workingDirectory('scout', null)).toBe(
      join(dir, 'data', 'workspaces', 'scout')
    );
    expect(statSync(join(dir, 'data', 'workspaces', 'scout')).isDirectory()).toBe(true);
    expect(await runtime.workingDirectory('scout', dir)).toBe(dir);
    await expect(runtime.workingDirectory('scout', 'relative/dir')).rejects.toMatchObject({
      reason: 'definition_invalid',
    });
    await expect(runtime.workingDirectory('scout', join(dir, 'missing'))).rejects.toMatchObject({
      reason: 'definition_invalid',
    });
    await expect(runtime.workingDirectory('scout', bundle)).rejects.toMatchObject({
      reason: 'definition_invalid',
    });
  });
});
