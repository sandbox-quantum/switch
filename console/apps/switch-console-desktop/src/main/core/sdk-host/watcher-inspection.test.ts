import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { inspectWatchers, removeWatcherRoots, waitForWatcherStop } from './watcher-inspection';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(agentId: string) {
  const home = await mkdtemp(join(tmpdir(), 'watcher-inspect-'));
  roots.push(home);
  const root = join(home, '.local/state/switch/sdk-watchers/example');
  await mkdir(join(root, 'supervisor'), { recursive: true });
  await writeFile(join(root, 'config.json'), JSON.stringify({ session: { agentId } }));
  await writeFile(join(root, 'watch.json'), JSON.stringify({ enabled: true, spawn: true }));
  return { home, root };
}
async function inspect(home: string, mode: 'status' | 'logs') {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['-e', inspectWatchers, 'agent', mode],
    { env: { ...process.env, HOME: home } }
  );
  return JSON.parse(stdout);
}
it('reports a stopped watcher and its failure without inventing a build or PID', async () => {
  const { home, root } = await fixture('agent');
  await writeFile(
    join(root, 'supervisor/failure.json'),
    JSON.stringify({ message: 'Connection failed' })
  );
  expect(await inspect(home, 'status')).toEqual([
    {
      running: false,
      enabled: true,
      pid: null,
      supervisorPid: null,
      takenOver: null,
      buildHash: null,
      failure: 'Connection failed',
    },
  ]);
});
it('reports a watcher standing down rather than leaving it to read as a crash', async () => {
  const { home, root } = await fixture('agent');
  await writeFile(
    join(root, 'taken-over.json'),
    JSON.stringify({
      at: '2026-01-01T00:00:00.000Z',
      reason: 'another stream attached to this connection',
      connectionId: 'controller',
    })
  );
  // Enabled and deliberately not running. Without this the panel shows the
  // same red "cannot start this agent" as a watcher that died.
  const [watcher] = await inspect(home, 'status');
  expect(watcher).toMatchObject({
    running: false,
    enabled: true,
    failure: null,
    takenOver: {
      at: '2026-01-01T00:00:00.000Z',
      reason: 'another stream attached to this connection',
    },
  });
});
it('does not expose another agent’s status or logs', async () => {
  const { home, root } = await fixture('another-agent');
  await writeFile(join(root, 'supervisor/worker.log'), 'Other agent log');
  expect(await inspect(home, 'status')).toEqual([]);
  expect(await inspect(home, 'logs')).toBe('');
});
it('bounds log reads and discloses truncation', async () => {
  const { home, root } = await fixture('agent');
  await writeFile(join(root, 'supervisor/worker.log'), 'x'.repeat(100_000) + 'latest line');
  const log = await inspect(home, 'logs');
  expect(log).toContain('[Earlier log omitted]');
  expect(log).toContain('latest line');
  expect(log.length).toBeLessThan(33_000);
});
it('surfaces corrupt state instead of claiming that the watcher is stopped', async () => {
  const { home, root } = await fixture('agent');
  await writeFile(join(root, 'shared-owner.lock'), JSON.stringify({ pid: -1 }));
  await expect(inspect(home, 'status')).rejects.toThrow('Invalid host PID');
});

it('identifies the actual running remote bundle', async () => {
  const { home, root } = await fixture('agent');
  const hash = 'a'.repeat(64);
  const entrypoint = join(home, `shared-host-${hash}.mjs`);
  await writeFile(entrypoint, "setInterval(() => {}, 1000); console.log('ready');");
  const child = spawn(process.execPath, [entrypoint, root, '--watch-supervise'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once('data', () => resolve());
      child.once('error', reject);
    });
    await writeFile(join(root, 'supervisor/owner.json'), JSON.stringify({ pid: child.pid }));
    await writeFile(join(root, 'shared-owner.lock'), JSON.stringify({ pid: child.pid }));
    expect(await inspect(home, 'status')).toEqual([
      {
        running: true,
        enabled: true,
        pid: child.pid,
        supervisorPid: child.pid,
        takenOver: null,
        buildHash: hash,
        failure: null,
      },
    ]);
  } finally {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    await exited;
  }
});

it('removes the state an agent’s controller left, under whichever key saved it', async () => {
  const { home, root } = await fixture('agent');
  // A root saved under an earlier key, which is how a renamed agent's journal
  // survives: found by the id in its config, not by the directory name.
  const keyed = join(
    home,
    '.local/state/switch/sdk-watchers',
    createHash('sha256').update('agent').digest('hex')
  );
  await mkdir(keyed, { recursive: true });
  await writeFile(join(keyed, 'watch.json'), JSON.stringify({ enabled: true, spawn: true }));
  const other = join(home, '.local/state/switch/sdk-watchers/other');
  await mkdir(other, { recursive: true });
  await writeFile(join(other, 'config.json'), JSON.stringify({ session: { agentId: 'another' } }));

  await promisify(execFile)(process.execPath, ['-e', removeWatcherRoots, 'agent'], {
    env: { ...process.env, HOME: home },
  });
  expect(existsSync(root)).toBe(false);
  expect(existsSync(keyed)).toBe(false);
  expect(existsSync(other)).toBe(true);
});

it('removing controller state is not an error when there is none', async () => {
  const home = await mkdtemp(join(tmpdir(), 'watcher-inspect-'));
  roots.push(home);
  await promisify(execFile)(process.execPath, ['-e', removeWatcherRoots, 'agent'], {
    env: { ...process.env, HOME: home },
  });
});

it('waits for a living supervisor even after the watcher has exited', async () => {
  const { root } = await fixture('agent');
  const child = spawn(process.execPath, ['-e', "setTimeout(() => {}, 600);console.log('ready')"], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once('data', () => resolve());
      child.once('error', reject);
    });
    await writeFile(join(root, 'supervisor/owner.json'), JSON.stringify({ pid: child.pid }));
    await promisify(execFile)(process.execPath, ['-e', waitForWatcherStop, root]);
    expect(() => process.kill(child.pid!, 0)).toThrow();
  } finally {
    child.kill();
  }
});
