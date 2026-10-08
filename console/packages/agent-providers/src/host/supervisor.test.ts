import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { OBSOLETE_BUNDLE_EXIT_CODE, WorkerObsoleteError } from './exit-codes';
import { CHILD_STOP_GRACE_MS, superviseSharedHost } from './supervisor';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'shared-supervisor-'));
  roots.push(root);
  return root;
}

it('restarts a crashed isolated worker and exits after a clean stop', async () => {
  const root = await fixture();
  const script = `
    const fs = require('node:fs');
    const root = ${JSON.stringify(root)};
    const marker = root + '/attempts';
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, '1');
      fs.writeFileSync(root + '/shared-owner.lock', JSON.stringify({pid: process.pid}));
      process.kill(process.pid, 'SIGKILL');
    }
    fs.writeFileSync(marker, '2');
  `;
  await superviseSharedHost({
    root,
    executable: process.execPath,
    args: ['-e', script],
    env: process.env,
    signal: new AbortController().signal,
    build: 'test-bundle.mjs',
    links: null,
    logRedactions: [],
  });
  expect(await readFile(join(root, 'attempts'), 'utf8')).toBe('2');
  await expect(readFile(join(root, 'supervisor', 'owner.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('reports a fatal worker failure instead of restarting it repeatedly', async () => {
  const root = await fixture();
  await expect(
    superviseSharedHost({
      root,
      executable: process.execPath,
      args: ['-e', 'process.exit(1)'],
      env: process.env,
      signal: new AbortController().signal,
      build: 'test-bundle.mjs',
      links: null,
      logRedactions: [],
    })
  ).rejects.toThrow('exit code 1');
  expect(
    JSON.parse(await readFile(join(root, 'supervisor', 'failure.json'), 'utf8')).message
  ).toContain('worker.log');
});

it('reaps provider descendants even after a clean worker exit', async () => {
  const root = await fixture();
  const script = `
    const fs = require('node:fs');
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(root)} + '/provider.pid', String(child.pid));
    fs.writeFileSync(${JSON.stringify(root)} + '/shared-owner.lock', JSON.stringify({ pid: process.pid, group: process.pid, token: 'test-owner' }));
    child.unref();
  `;
  await superviseSharedHost({
    root,
    executable: process.execPath,
    args: ['-e', script],
    env: process.env,
    signal: new AbortController().signal,
    build: 'test-bundle.mjs',
    links: null,
    logRedactions: [],
  });
  const pid = Number(await readFile(join(root, 'provider.pid'), 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
  await expect(readFile(join(root, 'shared-owner.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves the worker failure reason for Console startup', async () => {
  const root = await fixture();
  await expect(
    superviseSharedHost({
      root,
      executable: process.execPath,
      args: [
        '-e',
        "require('node:fs').writeFileSync(process.argv[1]+'/supervisor/failure.json', JSON.stringify({message:'Provider executable is missing'}));process.exit(1)",
        root,
      ],
      env: process.env,
      signal: new AbortController().signal,
      build: 'test-bundle.mjs',
      links: null,
      logRedactions: [],
    })
  ).rejects.toThrow('exit code 1');
  expect(JSON.parse(await readFile(join(root, 'supervisor', 'failure.json'), 'utf8')).message).toBe(
    'Provider executable is missing'
  );
});

async function leaseWorker(root: string, firstExit: number): Promise<string[]> {
  const path = join(root, 'worker.cjs');
  await writeFile(
    path,
    `
    const fs = require('node:fs');
    const root = process.argv[2];
    const marker = root + '/attempts';
    const attempt = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) + 1 : 1;
    fs.writeFileSync(marker, String(attempt));
    if (attempt > 1)
      fs.writeFileSync(
        root + '/lock-at-relaunch',
        fs.existsSync(root + '/shared-owner.lock') ? 'present' : 'missing'
      );
    fs.writeFileSync(
      root + '/shared-owner.lock',
      JSON.stringify({ pid: process.pid, group: process.pid, token: 'test-owner' })
    );
    if (attempt === 1) process.exit(${firstExit});
  `,
    { mode: 0o700 }
  );
  return [path, root];
}

it('stops without relaunching or recording a failure when the worker is obsolete', async () => {
  const root = await fixture();
  await expect(
    superviseSharedHost({
      root,
      executable: process.execPath,
      args: await leaseWorker(root, OBSOLETE_BUNDLE_EXIT_CODE),
      env: process.env,
      signal: new AbortController().signal,
      build: 'test-bundle.mjs',
      links: null,
      logRedactions: [],
    })
  ).rejects.toBeInstanceOf(WorkerObsoleteError);
  expect(await readFile(join(root, 'attempts'), 'utf8')).toBe('1');
  await expect(readFile(join(root, 'supervisor', 'failure.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(readFile(join(root, 'shared-owner.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not relaunch a worker that exits with a fatal code', async () => {
  const root = await fixture();
  await expect(
    superviseSharedHost({
      root,
      executable: process.execPath,
      args: await leaseWorker(root, 1),
      env: process.env,
      signal: new AbortController().signal,
      build: 'test-bundle.mjs',
      links: null,
      logRedactions: [],
    })
  ).rejects.toThrow('exit code 1');
  expect(await readFile(join(root, 'attempts'), 'utf8')).toBe('1');
  expect(
    JSON.parse(await readFile(join(root, 'supervisor', 'failure.json'), 'utf8')).message
  ).toContain('worker.log');
});

it('scrubs known secrets from the worker output before it reaches worker.log', async () => {
  const root = await fixture();
  const script = `
    process.stdout.write('token=synthetic-');
    setTimeout(() => {
      process.stdout.write('secret-value done\\n');
      process.stderr.write('failed with synthetic-secret-value\\n');
    }, 20);
  `;
  await superviseSharedHost({
    root,
    executable: process.execPath,
    args: ['-e', script],
    env: process.env,
    signal: new AbortController().signal,
    build: 'test-bundle.mjs',
    links: null,
    logRedactions: ['synthetic-secret-value'],
  });
  const log = await readFile(join(root, 'supervisor', 'worker.log'), 'utf8');
  expect(log).not.toContain('synthetic-secret-value');
  expect(log.match(/\[REDACTED\]/g)).toHaveLength(2);
  expect(log).toContain('token=[REDACTED]');
  expect(log).toContain('failed with [REDACTED]');
});

it('kills a worker that will not stop when asked, and everything it started', async () => {
  // A watcher waiting on a session host that hung up and stayed alive never
  // exits on SIGTERM, and a replacement waiting for it used to give up.
  const root = await fixture();
  const grandchildPid = join(root, 'grandchild.pid');
  const script = `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    // In a group of its own, as a session host is: killing the worker's
    // group alone would leave it.
    const child = require('node:child_process').spawn(process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      { detached: true, stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(grandchildPid)}, String(child.pid));
    setInterval(() => {}, 1000);
  `;
  const abort = new AbortController();
  const supervising = superviseSharedHost({
    root,
    executable: process.execPath,
    args: ['-e', script],
    env: process.env,
    signal: abort.signal,
    build: 'test-bundle.mjs',
    links: null,
    logRedactions: [],
  });
  let pid = 0;
  for (let attempt = 0; attempt < 100 && !pid; attempt++) {
    try {
      pid = Number(await readFile(grandchildPid, 'utf8'));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  expect(pid).toBeGreaterThan(0);

  const started = Date.now();
  abort.abort();
  await supervising;

  expect(Date.now() - started).toBeGreaterThanOrEqual(CHILD_STOP_GRACE_MS - 500);
  expect(() => process.kill(pid, 0)).toThrow();
}, 30_000);
