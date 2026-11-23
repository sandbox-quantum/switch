import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import {
  releaseOwner,
  replaceOwner,
  withOwnershipLock,
  withOwnershipLockOutlasting,
} from './ownership-lock';

if (process.platform === 'win32') vi.setConfig({ testTimeout: 60_000 });

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const moduleUrl = pathToFileURL(join(import.meta.dirname, 'ownership-lock.ts')).href;
async function rootDirectory() {
  const root = await mkdtemp(join(tmpdir(), 'ownership-crash-'));
  roots.push(root);
  return root;
}
async function child(root: string, stage: string): Promise<number | null> {
  const script = `
    import fs from 'node:fs/promises';
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    registerHooks({
      resolve: (specifier, context, next) =>
        next(/^\\.\\.?\\/(.*\\/)?[^./]+$/.test(specifier) ? specifier + '.ts' : specifier, context),
    });
    const root = ${JSON.stringify(root)};
    const stage = ${JSON.stringify(stage)};
    for (const operation of ['link', 'rename']) {
      const original = fs[operation];
      fs[operation] = async (...args) => {
        const kind = args[1].endsWith('shared-owner.lock') ? 'owner' : operation;
        if (stage === 'before-' + kind) process.kill(process.pid, 'SIGKILL');
        const value = await original(...args);
        if (stage === 'after-' + kind) process.kill(process.pid, 'SIGKILL');
        return value;
      };
    }
    syncBuiltinESMExports();
    const { withOwnershipLock, replaceOwner } = await import(${JSON.stringify(moduleUrl)});
    await withOwnershipLock(root, async () => {
      if (stage === 'critical') process.kill(process.pid, 'SIGKILL');
      await replaceOwner(root + '/shared-owner.lock', { pid: process.pid, group: process.pid });
      if (stage === 'contender') {
        await fs.appendFile(root + '/trace', 'start-' + process.pid + '\\n');
        await new Promise(resolve => setTimeout(resolve, 30));
        await fs.appendFile(root + '/trace', 'end-' + process.pid + '\\n');
      }
    });
  `;
  const processHandle = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const [code] = await once(processHandle, 'exit');
  return code;
}

/** How `child` reports a process that killed itself: by signal, or on Windows with exit code 1. */
const KILLED = process.platform === 'win32' ? 1 : null;

it.each([
  'before-link',
  'after-link',
  'before-rename',
  'after-rename',
  'critical',
  'before-owner',
  'after-owner',
])('recovers after a process crash at %s', async (stage) => {
  const root = await rootDirectory();
  expect(await child(root, stage)).toBe(KILLED);
  await withOwnershipLock(root, () =>
    replaceOwner(join(root, 'shared-owner.lock'), { pid: process.pid, group: null })
  );
  expect(JSON.parse(await readFile(join(root, 'shared-owner.lock'), 'utf8'))).toEqual({
    pid: process.pid,
    group: null,
  });
});

it('serializes competing replacement owners after an interrupted recovery', async () => {
  const root = await rootDirectory();
  await child(root, 'critical');
  expect(await Promise.all(Array.from({ length: 8 }, () => child(root, 'contender')))).toEqual(
    Array(8).fill(0)
  );
  const entries = (await readFile(join(root, 'trace'), 'utf8')).trim().split('\n');
  expect(entries).toHaveLength(16);
  for (let index = 0; index < entries.length; index += 2)
    expect(entries[index + 1]).toBe(entries[index].replace('start-', 'end-'));
});

it('late cleanup cannot delete a replacement owner, even with the same PID', async () => {
  const root = await rootDirectory();
  const path = join(root, 'shared-owner.lock');
  const old = { pid: process.pid, token: 'old' };
  const current = { pid: process.pid, token: 'current' };
  await replaceOwner(path, current);
  await releaseOwner(root, path, old);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(current);
  await releaseOwner(root, path, current);
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('outlasts a live process that left its ticket while shutting down, and names it', async () => {
  const root = await rootDirectory();
  // A Console that took the lock and is still exiting: alive, its ticket ahead.
  const exiting = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
    stdio: 'ignore',
  });
  await once(exiting, 'spawn');
  await mkdir(join(root, 'ownership'));
  await writeFile(
    join(root, 'ownership', `${exiting.pid}-00000000-0000-0000-0000-000000000000.json`),
    JSON.stringify({ choosing: false, ticket: 1 })
  );
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    setTimeout(() => exiting.kill('SIGKILL'), 17_000);
    const owned = await withOwnershipLockOutlasting(
      root,
      async () => 'owner',
      new AbortController().signal
    );
    expect(owned).toEqual({ value: 'owner' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`another live host is acquiring ownership (pid ${exiting.pid})`)
    );
  } finally {
    warn.mockRestore();
    exiting.kill('SIGKILL');
  }
}, 40_000);

it('passes over a ticket left by an earlier process that had this id', async () => {
  // A container restarting gives the controller the same low id as the one
  // killed in the middle of an election, so its own id names the old ticket.
  const root = await mkdtemp(join(tmpdir(), 'ownership-reused-pid-'));
  roots.push(root);
  await mkdir(join(root, 'ownership'), { recursive: true });
  await writeFile(
    join(root, 'ownership', `${process.pid}-00000000-0000-4000-8000-000000000000.json`),
    JSON.stringify({ choosing: false, ticket: 1 })
  );
  const started = performance.now();
  await expect(withOwnershipLock(root, async () => 'taken')).resolves.toBe('taken');
  // Without the fix it waits the full 15 s for the ticket and then refuses.
  expect(performance.now() - started).toBeLessThan(5000);
});

it('still waits for a ticket another live process holds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ownership-live-ticket-'));
  roots.push(root);
  await mkdir(join(root, 'ownership'), { recursive: true });
  await writeFile(
    join(root, 'ownership', `${process.ppid}-00000000-0000-4000-8000-000000000000.json`),
    JSON.stringify({ choosing: false, ticket: 1 })
  );
  await expect(withOwnershipLock(root, async () => 'taken')).rejects.toThrow('FENCING_REQUIRED');
}, 30_000);

it.skipIf(process.platform === 'win32')(
  'passes over a ticket left by an earlier process whose id a later one holds now',
  async () => {
    // A ticket mid-choice, from a process that died; its id now belongs to a
    // live, later process. Counted as a contender it would hold the lock forever.
    const root = await rootDirectory();
    const directory = join(root, 'ownership');
    await mkdir(directory, { recursive: true });
    const ticket = join(directory, `${process.ppid}-00000000-0000-4000-8000-000000000000.json`);
    await writeFile(ticket, JSON.stringify({ choosing: true, ticket: 0 }));
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 3600 * 1000);
    await utimes(ticket, fourDaysAgo, fourDaysAgo);
    const ran = await Promise.race([
      withOwnershipLock(root, async () => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    expect(ran).toBe(true);
  }
);
