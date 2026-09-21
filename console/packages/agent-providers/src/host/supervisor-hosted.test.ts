import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { fenceDeadOwner } from './process-fence';
import { superviseSharedHost } from './supervisor';

const roots: string[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function kill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function readPid(path: string): Promise<number | null> {
  try {
    const pid = Number(await readFile(path, 'utf8'));
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hosted-supervisor-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    for (const name of ['worker.pid', 'descendant.pid']) {
      const pid = await readPid(join(root, name));
      if (pid && pid !== process.pid) kill(pid);
    }
    try {
      const owner = JSON.parse(await readFile(join(root, 'shared-owner.lock'), 'utf8'));
      if (Number.isSafeInteger(owner.group) && owner.group > 0 && owner.group !== process.pid)
        kill(-owner.group);
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    await rm(root, { recursive: true, force: true });
  }
});

it('fences a descendant that inherits redacted log pipes before waiting for log completion', async () => {
  const root = await fixture();
  const script = `
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      const root = process.argv[1];
      const descendant = spawn(
        process.execPath,
        ['-e', "process.stdout.write('descendant-ready\\n'); setInterval(() => {}, 1000)"],
        { stdio: ['ignore', 1, 2] }
      );
      fs.writeFileSync(root + '/descendant.pid', String(descendant.pid));
      fs.writeFileSync(
        root + '/shared-owner.lock',
        JSON.stringify({ pid: process.pid, group: process.pid, token: 'worker' })
      );
      process.stdout.write('provider-secret\\n');
      descendant.unref();
    `;

  await superviseSharedHost({
    root,
    executable: process.execPath,
    args: ['-e', script, root],
    env: process.env,
    signal: new AbortController().signal,
    build: 'hosted-test-build',
    existingWorker: 'reject',
    fenceDeadWorker: fenceDeadOwner,
    logRedactions: ['provider-secret'],
    shutdownTimeoutMs: 100,
    clearFailureOnStart: true,
  });

  const descendant = await readPid(join(root, 'descendant.pid'));
  expect(descendant).not.toBeNull();
  expect(alive(descendant!)).toBe(false);
  const log = await readFile(join(root, 'supervisor', 'worker.log'), 'utf8');
  expect(log).toContain('[REDACTED]');
  expect(log).not.toContain('provider-secret');
  await expect(readFile(join(root, 'shared-owner.lock'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
}, 10000);

it('kills and fences a hosted worker that ignores SIGTERM after the configured timeout', async () => {
  const root = await fixture();
  const ready = join(root, 'ready');
  const controller = new AbortController();
  const script = `
      const fs = require('node:fs');
      const root = process.argv[1];
      fs.writeFileSync(root + '/worker.pid', String(process.pid));
      fs.writeFileSync(
        root + '/shared-owner.lock',
        JSON.stringify({ pid: process.pid, group: process.pid, token: 'worker' })
      );
      process.on('SIGTERM', () => {});
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      process.stdout.write('provider-secret\\n');
      setInterval(() => {}, 1000);
    `;
  const running = superviseSharedHost({
    root,
    executable: process.execPath,
    args: ['-e', script, root],
    env: process.env,
    signal: controller.signal,
    build: 'hosted-test-build',
    existingWorker: 'reject',
    fenceDeadWorker: fenceDeadOwner,
    logRedactions: ['provider-secret'],
    shutdownTimeoutMs: 50,
    clearFailureOnStart: true,
  });
  await expect.poll(async () => readFile(ready, 'utf8')).toBe('ready');

  controller.abort();
  await running;

  const worker = await readPid(join(root, 'worker.pid'));
  expect(worker).not.toBeNull();
  expect(alive(worker!)).toBe(false);
  await expect(readFile(join(root, 'shared-owner.lock'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
}, 10000);

it('propagates a fencing failure during hosted shutdown', async () => {
  const root = await fixture();
  const ready = join(root, 'ready');
  const controller = new AbortController();
  const script = `
    const fs = require('node:fs');
    const root = process.argv[1];
    fs.writeFileSync(root + '/worker.pid', String(process.pid));
    fs.writeFileSync(
      root + '/shared-owner.lock',
      JSON.stringify({ pid: process.pid, group: process.pid, token: 'worker' })
    );
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    setInterval(() => {}, 1000);
  `;
  const running = superviseSharedHost({
    root,
    executable: process.execPath,
    args: ['-e', script, root],
    env: process.env,
    signal: controller.signal,
    build: 'hosted-test-build',
    existingWorker: 'reject',
    fenceDeadWorker: async () => {
      throw new Error('descendant fencing failed');
    },
    logRedactions: ['provider-secret'],
    shutdownTimeoutMs: 100,
    clearFailureOnStart: true,
  });
  await expect.poll(async () => readFile(ready, 'utf8')).toBe('ready');

  controller.abort();
  await expect(running).rejects.toThrow('descendant fencing failed');
  await expect(readFile(join(root, 'supervisor', 'owner.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('preserves the prior failure when a live hosted worker prevents replacement', async () => {
  const root = await fixture();
  const directory = join(root, 'supervisor');
  await mkdir(directory);
  await writeFile(
    join(root, 'shared-owner.lock'),
    JSON.stringify({ pid: process.pid, group: null, token: 'living-worker' })
  );
  const failure = JSON.stringify({ message: 'prior provider failure' });
  await writeFile(join(directory, 'failure.json'), failure);

  await expect(
    superviseSharedHost({
      root,
      executable: process.execPath,
      args: ['-e', 'throw new Error("must not spawn")'],
      env: process.env,
      signal: new AbortController().signal,
      build: 'hosted-test-build',
      existingWorker: 'reject',
      fenceDeadWorker: fenceDeadOwner,
      logRedactions: ['provider-secret'],
      shutdownTimeoutMs: 50,
      clearFailureOnStart: true,
    })
  ).rejects.toThrow('refusing to adopt');

  expect(await readFile(join(directory, 'failure.json'), 'utf8')).toBe(failure);
});
