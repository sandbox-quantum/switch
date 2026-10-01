import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BringUpOptions } from './watcher-bring-up';

// Only the script is run here; the transport around it is never reached.
vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({ ensureSshConnected: vi.fn() }));
vi.mock('@main/core/execution-context/ssh-execution-context', () => ({
  SshExecutionContext: vi.fn(),
}));
vi.mock('@main/core/fs/impl/ssh-fs', () => ({ SshFileSystem: vi.fn() }));
vi.mock('./host-bundle', () => ({ ensureHostBundle: vi.fn(), forgetHostBundle: vi.fn() }));

const { BRING_UP_SCRIPT } = await import('./watcher-bring-up');

/**
 * The bring-up script run for real, with `node`, against a home directory
 * standing in for the agent's host, and a stand-in launcher that records what
 * it was started with and what configuration it read.
 */

let home: string;
let root: string;
let staging: string;
let launcher: string;
let launches: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bring-up-'));
  const watchers = join(home, '.local/state/switch/sdk-watchers');
  root = join(watchers, createHash('sha256').update('switch-agent-1').digest('hex'));
  staging = join(home, '.local/state/switch/sdk-launch/launch-1');
  launches = join(home, 'launches.jsonl');
  launcher = join(home, 'launcher.cjs');
  writeFileSync(
    launcher,
    `const fs = require('node:fs');
const [root, config, mode, resuming] = process.argv.slice(2);
if (process.env.FAIL_LAUNCH) { console.error('provider not signed in'); process.exit(3); }
fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ root, mode, resuming,
  config: JSON.parse(fs.readFileSync(config, 'utf8')) }) + '\\n');
console.log('{"created":false}');`
  );
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function stage(runtimeMode: string) {
  mkdirSync(staging, { recursive: true });
  writeFileSync(
    join(staging, 'config.json'),
    JSON.stringify({ session: { agentId: 'switch-agent-1' }, start: { input: { runtimeMode } } })
  );
}

function options(overrides: Partial<BringUpOptions> = {}): BringUpOptions {
  return {
    identity: 'switch-agent-1',
    repoDir: join(home, 'work'),
    slug: 'scout',
    enabled: true,
    spawn: true,
    clear: false,
    adoptAutoApprove: true,
    entrypoint: launcher,
    staging,
    ...overrides,
  };
}

async function bringUp(overrides: Partial<BringUpOptions> = {}, env: Record<string, string> = {}) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['-e', BRING_UP_SCRIPT, JSON.stringify(options(overrides))],
    { env: { ...process.env, HOME: home, ...env } }
  );
  return JSON.parse(stdout.trim()) as { root: string; runtimeMode: string | null };
}

function launched(): { root: string; mode: string; resuming: string; config: any }[] {
  return existsSync(launches)
    ? readFileSync(launches, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
}

const watchFlags = () => JSON.parse(readFileSync(join(root, 'watch.json'), 'utf8'));

it('writes the flags and launches the watcher from its staged configuration, in one go', async () => {
  stage('approval-required');

  const result = await bringUp();

  expect(result).toEqual({ root, runtimeMode: null, legacyStopped: [] });
  expect(watchFlags()).toEqual({ enabled: true, spawn: true });
  expect(launched()).toEqual([
    {
      root,
      mode: '--ensure-watch',
      resuming: 'false',
      config: expect.objectContaining({ session: { agentId: 'switch-agent-1' } }),
    },
  ]);
  // It holds the agent's credentials, so it does not outlive the launch.
  expect(existsSync(staging)).toBe(false);
});

it('takes auto-approve from the host when another Console chose differently', async () => {
  stage('approval-required');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'auto-approve.json'), JSON.stringify({ runtimeMode: 'full-access' }));

  const result = await bringUp();

  expect(result.runtimeMode).toBe('full-access');
  expect(launched()[0]!.config.start.input.runtimeMode).toBe('full-access');
});

it('keeps this Console’s value when nobody chose on the host, or when told to', async () => {
  stage('full-access');
  expect((await bringUp()).runtimeMode).toBeNull();
  expect(launched()[0]!.config.start.input.runtimeMode).toBe('full-access');

  stage('full-access');
  writeFileSync(
    join(root, 'auto-approve.json'),
    JSON.stringify({ runtimeMode: 'approval-required' })
  );
  expect((await bringUp({ adoptAutoApprove: false })).runtimeMode).toBeNull();
  expect(launched()[1]!.config.start.input.runtimeMode).toBe('full-access');
});

it('stops a watcher without launching anything, clearing a takeover only when asked', async () => {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'taken-over.json'), JSON.stringify({ reason: 'another client' }));

  await bringUp({ enabled: false, spawn: false, staging: null, clear: false });
  expect(watchFlags()).toEqual({ enabled: false, spawn: false });
  expect(existsSync(join(root, 'taken-over.json'))).toBe(true);

  await bringUp({ enabled: false, spawn: false, staging: null, clear: true });
  expect(existsSync(join(root, 'taken-over.json'))).toBe(false);
  expect(launched()).toEqual([]);
});

it('says why the launcher failed, and removes the staged configuration anyway', async () => {
  stage('full-access');

  await expect(bringUp({}, { FAIL_LAUNCH: '1' })).rejects.toThrow(
    /launcher failed \(exit 3\): provider not signed in/
  );
  expect(existsSync(staging)).toBe(false);
});
