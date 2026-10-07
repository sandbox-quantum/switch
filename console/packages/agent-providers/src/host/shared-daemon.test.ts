import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildSharedHostConfig } from './build-shared-config';
import { OBSOLETE_BUNDLE_EXIT_CODE } from './exit-codes';

const DAEMON = fileURLToPath(new URL('./shared-daemon.ts', import.meta.url));
const AGENT = 'agent-placeholder';

let base: string;
let agentRoot: string;
let watcherRoot: string;
let credentials: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'shared-daemon-')));
  agentRoot = join(base, 'agents', AGENT);
  watcherRoot = join(agentRoot, 'watcher');
  credentials = join(base, 'credentials');
  await mkdir(watcherRoot, { recursive: true });
  await mkdir(credentials);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function daemon(
  args: string[],
  env: Record<string, string>
): Promise<{ code: number | null; stderr: string }> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('SWITCH_') && key !== 'CREDENTIALS_DIRECTORY'
    )
  );
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', DAEMON, ...args],
      { env: { ...inherited, ...env }, timeout: 30_000 },
      (_error, _stdout, stderr) => resolve({ code: child.exitCode, stderr })
    );
  });
}

async function writeUnitState(flags: { enabled: boolean }): Promise<void> {
  const binary = join(base, 'claude');
  await writeFile(binary, '#!/bin/sh\nexit 0\n');
  await chmod(binary, 0o700);
  const config = buildSharedHostConfig({
    session: { sessionId: `watcher-${AGENT}`, agentId: AGENT, provider: 'claude' },
    launch: { cwd: join(base, 'workspace'), runtimeMode: 'full-access', env: {}, model: undefined },
    capabilities: { approvals: true, userInput: true },
    execution: {
      credentialsPath: join(credentials, 'agent'),
      inheritEnv: ['PATH'],
      binaryPath: binary,
      codexConfig: '',
      skill: '',
      context: '',
      agentDefinition: undefined,
    },
    ids: { hostId: 'host', epoch: 'epoch', connectionId: 'connection' },
  });
  await writeFile(join(watcherRoot, 'config.json'), JSON.stringify(config));
  await writeFile(join(watcherRoot, 'watch.json'), JSON.stringify({ ...flags, spawn: true }));
  await writeFile(
    join(agentRoot, 'workspace.json'),
    JSON.stringify({
      repository: null,
      mirrorPath: null,
      workspacePath: join(base, 'workspace'),
      skills: [],
      instructions: '',
    })
  );
  await writeFile(
    join(credentials, 'agent'),
    JSON.stringify({
      env: {
        SWITCH_API_ENDPOINT: 'http://127.0.0.1:47100',
        SWITCH_API_TOKEN: 'relay-token-placeholder',
        SWITCH_AGENT_ID: AGENT,
      },
    })
  );
}

async function failure(root: string): Promise<string> {
  return JSON.parse(await readFile(join(root, 'supervisor', 'failure.json'), 'utf8')).message;
}

it('a unit whose watcher stood down after a takeover exits so systemd does not restart it', async () => {
  await writeUnitState({ enabled: true });
  await writeFile(
    join(watcherRoot, 'taken-over.json'),
    JSON.stringify({ at: '2026-01-01T00:00:00Z', reason: 'test', connectionId: 'connection' })
  );
  // Left by an earlier run of the unit, naming a process this user may not signal.
  await writeFile(join(watcherRoot, 'shared-owner.lock'), JSON.stringify({ pid: 1, token: 'old' }));
  await mkdir(join(watcherRoot, 'supervisor'));
  await writeFile(join(watcherRoot, 'supervisor', 'owner.json'), JSON.stringify({ pid: 1 }));

  const result = await daemon(['--unit', watcherRoot], { SWITCH_HOST_SHARED_GROUP: '1' });

  expect(result.code, result.stderr).toBe(OBSOLETE_BUNDLE_EXIT_CODE);
  const health = JSON.parse(await readFile(join(watcherRoot, 'health.json'), 'utf8'));
  expect(health.state).toBe('taken-over');
  expect((await stat(join(watcherRoot, 'health.json'))).mode & 0o777).toBe(0o640);
  await expect(stat(join(watcherRoot, 'supervisor', 'owner.json'))).rejects.toThrow();
});

it('a unit whose watcher is turned off exits cleanly', async () => {
  await writeUnitState({ enabled: false });
  const result = await daemon(['--unit', watcherRoot], { SWITCH_HOST_SHARED_GROUP: '1' });
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(await readFile(join(watcherRoot, 'health.json'), 'utf8')).state).toBe(
    'disabled'
  );
});

it('a unit records why it could not start in its watcher root', async () => {
  const result = await daemon(['--unit', watcherRoot], { SWITCH_HOST_SHARED_GROUP: '1' });
  expect(result.code).toBe(1);
  expect(await failure(watcherRoot)).toContain('config.json');
  expect((await stat(join(watcherRoot, 'supervisor', 'failure.json'))).mode & 0o777).toBe(0o640);
});

it('prepares an agent root from its systemd credentials', async () => {
  await writeUnitState({ enabled: true });
  await writeFile(
    join(credentials, 'provider'),
    JSON.stringify({
      status: 'connected',
      revision: '1',
      provider: 'claude',
      kind: 'setup-token',
      credential: 'token-placeholder',
    })
  );
  await writeFile(
    join(agentRoot, 'workspace.json'),
    JSON.stringify({
      repository: null,
      mirrorPath: null,
      workspacePath: join(base, 'workspace'),
      skills: [],
      instructions: '',
    })
  );
  await mkdir(join(watcherRoot, 'supervisor'));
  await writeFile(join(watcherRoot, 'supervisor', 'failure.json'), '{"message":"earlier"}');

  const result = await daemon(['--prepare', agentRoot], { CREDENTIALS_DIRECTORY: credentials });

  expect(result.code, result.stderr).toBe(0);
  expect((await stat(join(base, 'workspace'))).isDirectory()).toBe(true);
  expect((await stat(join(agentRoot, 'home'))).isDirectory()).toBe(true);
  await expect(stat(join(watcherRoot, 'supervisor', 'failure.json'))).rejects.toThrow();
});

it('a preparation without systemd credentials fails and says so', async () => {
  const result = await daemon(['--prepare', agentRoot], {});
  expect(result.code).toBe(1);
  expect(await failure(watcherRoot)).toContain('CREDENTIALS_DIRECTORY is not set');
});
