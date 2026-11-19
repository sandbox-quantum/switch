import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionLinks } from './session-channel';
import { AdoptUnsureError, CHILD_STOP_GRACE_MS, superviseSharedHost } from './supervisor';

// Each worker exit is fenced on Windows through PowerShell, which takes seconds to start.
if (process.platform === 'win32') vi.setConfig({ testTimeout: 60_000 });

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
      // A crash: a signal, or on Windows an exception's NTSTATUS exit code.
      if (process.platform === 'win32') process.exit(0xc0000005);
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
  });
  expect(await readFile(join(root, 'attempts'), 'utf8')).toBe('2');
  await expect(readFile(join(root, 'supervisor', 'owner.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('does not restart a crashed worker itself on a launcher box, and fails so the launcher reports it', async () => {
  const root = await fixture();
  const script = `
    const fs = require('node:fs');
    const root = ${JSON.stringify(root)};
    fs.appendFileSync(root + '/attempts', 'x');
    fs.writeFileSync(root + '/shared-owner.lock', JSON.stringify({pid: process.pid}));
    if (process.platform === 'win32') process.exit(0xc0000005);
    process.kill(process.pid, 'SIGKILL');
  `;
  await expect(
    superviseSharedHost({
      root,
      executable: process.execPath,
      args: ['-e', script],
      env: process.env,
      signal: new AbortController().signal,
      build: 'test-bundle.mjs',
      links: null,
      selfRestart: false,
    })
  ).rejects.toThrow('not restarting it here');
  expect(await readFile(join(root, 'attempts'), 'utf8')).toBe('x');
  // Not a fatal failure: the controller may start it again.
  await expect(readFile(join(root, 'supervisor', 'failure.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('hands its worker the push key on a pipe of its own, fd 3', async () => {
  const root = await fixture();
  const key = Buffer.alloc(32, 0xab);
  const script = `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(root)} + '/key', fs.readFileSync(3).toString('hex'));
  `;
  await superviseSharedHost({
    root,
    executable: process.execPath,
    args: ['-e', script],
    env: process.env,
    signal: new AbortController().signal,
    build: 'test-bundle.mjs',
    links: null,
    pushKey: key,
  });
  expect(await readFile(join(root, 'key'), 'utf8')).toBe(key.toString('hex'));
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
    })
  ).rejects.toThrow('exit code 1');
  expect(await readFile(join(root, 'attempts'), 'utf8')).toBe('1');
  expect(
    JSON.parse(await readFile(join(root, 'supervisor', 'failure.json'), 'utf8')).message
  ).toContain('worker.log');
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

// A container restarting gives the new controller the same low process id as
// the one that crashed, so its own id is in the record the old one left.
async function staleRecord(root: string, record: object) {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'supervisor'), { recursive: true });
  await writeFile(join(root, 'supervisor', 'owner.json'), JSON.stringify(record));
}
const cleanWorker = (root: string) => ({
  root,
  executable: process.execPath,
  args: ['-e', ''],
  env: process.env,
  signal: new AbortController().signal,
  build: 'test-bundle.mjs',
  links: null,
});

it('takes over a supervisor record left by an earlier process that had this id', async () => {
  const root = await fixture();
  await staleRecord(root, { pid: process.pid, token: 'left-by-the-process-before', build: 'x' });
  await superviseSharedHost(cleanWorker(root));
  await expect(readFile(join(root, 'supervisor', 'owner.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('takes over a supervisor record with this id and no token', async () => {
  const root = await fixture();
  await staleRecord(root, { pid: process.pid });
  await expect(superviseSharedHost(cleanWorker(root))).resolves.toBeUndefined();
});

it('still refuses a supervisor record held by another live process', async () => {
  const root = await fixture();
  await staleRecord(root, { pid: process.ppid, token: 'the-parent-holds-it', build: 'x' });
  await expect(superviseSharedHost(cleanWorker(root))).rejects.toThrow(
    'The shared host supervisor is already running.'
  );
});

it('still refuses a second supervisor in this process while the first runs', async () => {
  const root = await fixture();
  const first = new AbortController();
  const running = superviseSharedHost({
    ...cleanWorker(root),
    args: ['-e', 'setTimeout(() => {}, 60000)'],
    signal: first.signal,
  });
  try {
    for (let i = 0; i < 100; i++) {
      try {
        await readFile(join(root, 'supervisor', 'owner.json'));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await expect(superviseSharedHost(cleanWorker(root))).rejects.toThrow(
      'The shared host supervisor is already running.'
    );
  } finally {
    first.abort();
    await running;
  }
});

it('does not wait for ever on an earlier worker it cannot tell is alive, and starts no second one', async () => {
  // user-b-pm, 27 Oct: a supervisor waited for ever to "adopt" a worker that was
  // really another process's thread, so the agent went silent.
  const root = await mkdtemp(join(tmpdir(), 'supervisor-unsure-'));
  try {
    await writeFile(join(root, 'shared-owner.lock'), JSON.stringify({ pid: process.ppid }));
    const started = Date.now();
    await expect(
      superviseSharedHost({
        root,
        executable: process.execPath,
        args: [
          '-e',
          "require('node:fs').writeFileSync(process.argv[1], 'spawned')",
          join(root, 'spawned'),
        ],
        env: process.env,
        signal: new AbortController().signal,
        build: 'test-bundle.mjs',
        links: null,
        unsureLimitMs: 600,
        judge: async () => ({ kind: 'unknown' }),
      })
    ).rejects.toBeInstanceOf(AdoptUnsureError);
    expect(Date.now() - started).toBeLessThan(5_000);
    await expect(readFile(join(root, 'spawned'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(() => process.kill(process.ppid, 0)).not.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('still waits on, and never replaces, an earlier worker judged alive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-alive-'));
  const stop = new AbortController();
  try {
    await writeFile(join(root, 'shared-owner.lock'), JSON.stringify({ pid: process.ppid }));
    const running = superviseSharedHost({
      root,
      executable: process.execPath,
      args: [
        '-e',
        "require('node:fs').writeFileSync(process.argv[1], 'spawned')",
        join(root, 'spawned'),
      ],
      env: process.env,
      signal: stop.signal,
      build: 'test-bundle.mjs',
      links: null,
      unsureLimitMs: 300,
      judge: async () => ({ kind: 'alive' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await expect(readFile(join(root, 'spawned'))).rejects.toMatchObject({ code: 'ENOENT' });
    stop.abort();
    await running.catch(() => {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('tells the agent host when a supervisor gave up before spawning anything', () => {
  const links = new SessionLinks();
  const heard: string[] = [];
  links.onFailure((root, failure) => heard.push(`${root}: ${failure}`));
  links.reportFailure(
    '/sessions/one',
    'Could not tell for 60 s whether the earlier worker is still running.'
  );
  expect(heard).toEqual([
    '/sessions/one: Could not tell for 60 s whether the earlier worker is still running.',
  ]);
  expect(links.failure('/sessions/one')).toContain('Could not tell');
});

it('refuses to take over a supervisor it cannot tell is alive, with the error the room is told about', async () => {
  // Site 4: an "unknown" supervisor record must not end silently.
  const root = await mkdtemp(join(tmpdir(), 'supervisor-start-unsure-'));
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'supervisor'), { recursive: true });
    await writeFile(
      join(root, 'supervisor', 'owner.json'),
      JSON.stringify({ pid: process.ppid, token: 'theirs' })
    );
    const base = {
      root,
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: process.env,
      signal: new AbortController().signal,
      build: 'test-bundle.mjs',
      links: null,
    };
    await expect(
      superviseSharedHost({ ...base, judge: async () => ({ kind: 'unknown' }) })
    ).rejects.toBeInstanceOf(AdoptUnsureError);
    await expect(
      superviseSharedHost({ ...base, judge: async () => ({ kind: 'alive' }) })
    ).rejects.toThrow('already running');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
