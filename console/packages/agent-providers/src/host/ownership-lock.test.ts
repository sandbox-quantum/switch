import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { releaseOwner, replaceOwner, withOwnershipLock } from './ownership-lock';

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
    import { syncBuiltinESMExports } from 'node:module';
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
    stdio: 'ignore',
  });
  const [code] = await once(processHandle, 'exit');
  return code;
}

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
  expect(await child(root, stage)).toBeNull();
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
