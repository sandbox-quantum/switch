import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  detachedSupervision,
  ensureSharedProcess,
  inProcessSupervision,
  liveSupervisor,
} from './launch';
import { killProcessTree } from './process-fence';
import { SessionLinks } from './session-channel';
import { owedSessionStart, type HostStartSource } from './session-start';
import type { SharedHostConfig } from './shared-config';
import { stopWasAsked } from './stop-asked';

if (process.platform === 'win32') vi.setConfig({ testTimeout: 60_000 });

/**
 * Script for a stand-in host that runs `then` when asked to stop, as a real
 * one does: on SIGTERM, or on Windows when its stop file appears in `root`.
 */
function onStop(root: string, then: string): string {
  return `{
    const stop = () => { ${then} };
    process.on('SIGTERM', stop);
    const file = require('node:path').join(${JSON.stringify(root)}, '.stop-' + process.pid);
    const poll = setInterval(() => {
      if (require('node:fs').existsSync(file)) { clearInterval(poll); stop(); }
    }, 50);
  }`;
}

/** Ends what a test started, the process and what it started. */
async function cleanUp(pid: number | undefined): Promise<void> {
  if (!pid) return;
  try {
    if (process.platform === 'win32') await killProcessTree(pid);
    else process.kill(-pid, 'SIGKILL');
  } catch {}
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'shared-launch-'));
  roots.push(root);
  const config: SharedHostConfig = {
    session: {
      sessionId: 'session',
      agentId: 'agent',
      hostId: 'host',
      epoch: 'initial',
      provider: 'codex',
      status: 'starting',
      connectivity: 'online',
      pendingRequestIds: [],
      capabilities: {
        input: 'queue',
        approvals: true,
        questions: true,
        interrupt: true,
        reset: false,
        compact: false,
        modelChange: false,
        attachmentMimeTypes: [],
      },
    },
    start: {
      provider: 'codex',
      input: {
        sessionId: 'session',
        cwd: root,
        runtimeMode: 'approval-required',
        env: {},
        mcpServers: {},
      },
    },
  };
  const entrypoint = join(root, 'worker.cjs');
  return {
    root,
    config,
    entrypoint,
    resuming: true,
    watcher: false,
    restart: true,
    supervision: detachedSupervision(entrypoint),
    startSource: null as HostStartSource | null,
  };
}
it('refuses to replace missing conversation state with a fresh session', async () => {
  await expect(ensureSharedProcess(await fixture())).rejects.toThrow('no saved SDK conversation');
});
it('waits for the old owner to exit before starting its replacement', async () => {
  const input = await fixture();
  await writeFile(join(input.root, 'config.json'), JSON.stringify(input.config));
  await writeFile(
    input.entrypoint,
    `const fs=require('node:fs');fs.appendFileSync(process.argv[2]+'/trace','new\\n');`
  );
  const old = spawn(
    process.execPath,
    [
      '-e',
      `const fs=require('node:fs');const root=process.argv[1];fs.writeFileSync(root+'/shared-owner.lock',JSON.stringify({pid:process.pid}));${onStop(input.root, "setTimeout(()=>{fs.appendFileSync(root+'/trace','old-stopped\\n');process.exit(0)},200)")};console.log('ready');setInterval(()=>{},1000);`,
      input.root,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  try {
    await once(old.stdout!, 'data');
    const exit = once(old, 'exit');
    await ensureSharedProcess(input);
    await exit;
    await expect
      .poll(async () => readFile(join(input.root, 'trace'), 'utf8'))
      .toBe('old-stopped\nnew\n');
    expect(JSON.parse(await readFile(join(input.root, 'config.json'), 'utf8')).session).toEqual(
      input.config.session
    );
  } finally {
    if (old.exitCode === null) old.kill('SIGKILL');
  }
});

it('refreshes renamed agent configuration without changing the saved session', async () => {
  const input = await fixture();
  input.restart = false;
  input.config.start.input.agentName = 'old-name';
  input.config.roomConnection = { connectionId: 'connection' };
  await writeFile(join(input.root, 'config.json'), JSON.stringify(input.config));
  await mkdir(join(input.root, 'supervisor'));
  await writeFile(
    join(input.root, 'supervisor', 'owner.json'),
    JSON.stringify({ pid: process.pid, build: input.supervision.build })
  );
  input.config = structuredClone(input.config);
  input.config.start.input.agentName = 'new-name';
  input.config.session.hostId = 'proposed-new-host';
  input.config.roomConnection = { connectionId: 'new-connection' };
  expect(await ensureSharedProcess(input)).toEqual({ created: false });
  const saved = JSON.parse(await readFile(join(input.root, 'config.json'), 'utf8'));
  expect(saved.start.input.agentName).toBe('new-name');
  expect(saved.session.hostId).toBe('host');
  expect(saved.roomConnection).toEqual({ connectionId: 'new-connection' });
});

it('gives a controller the connection it was asked for rather than the one on disk', async () => {
  const input = await fixture();
  input.restart = false;
  input.watcher = true;
  input.config.roomConnection = { connectionId: 'written-at-first-launch' };
  await writeFile(join(input.root, 'config.json'), JSON.stringify(input.config));
  await mkdir(join(input.root, 'supervisor'));
  await writeFile(
    join(input.root, 'supervisor', 'owner.json'),
    JSON.stringify({ pid: process.pid, build: input.supervision.build })
  );
  input.config = structuredClone(input.config);
  input.config.roomConnection = { connectionId: 'derived-from-the-agent' };
  expect(await ensureSharedProcess(input)).toEqual({ created: false });
  const saved = JSON.parse(await readFile(join(input.root, 'config.json'), 'utf8'));
  expect(saved.roomConnection).toEqual({ connectionId: 'derived-from-the-agent' });
});

it('replaces a supervisor an earlier deployment left running', async () => {
  const input = await fixture();
  input.restart = false;
  await writeFile(join(input.root, 'config.json'), JSON.stringify(input.config));
  await writeFile(
    input.entrypoint,
    `const fs=require('node:fs');fs.appendFileSync(process.argv[2]+'/trace','new\\n');`
  );
  await mkdir(join(input.root, 'supervisor'));
  const old = spawn(
    process.execPath,
    [
      '-e',
      `${onStop(input.root, 'process.exit(0)')};console.log('ready');setInterval(()=>{},1000);`,
      input.root,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  try {
    await once(old.stdout!, 'data');
    await writeFile(
      join(input.root, 'supervisor', 'owner.json'),
      JSON.stringify({
        pid: old.pid,
        build: join(input.root, 'superseded.cjs'),
      })
    );
    const exit = once(old, 'exit');
    expect(await ensureSharedProcess(input)).toEqual({ created: false });
    await exit;
    await expect.poll(async () => readFile(join(input.root, 'trace'), 'utf8')).toBe('new\n');
  } finally {
    if (old.exitCode === null) old.kill('SIGKILL');
  }
});

it('leaves a supervisor running the deployed build alone', async () => {
  const input = await fixture();
  input.restart = false;
  await writeFile(join(input.root, 'config.json'), JSON.stringify(input.config));
  await writeFile(
    input.entrypoint,
    `const fs=require('node:fs');fs.appendFileSync(process.argv[2]+'/trace','new\\n');`
  );
  await mkdir(join(input.root, 'supervisor'));
  const running = spawn(
    process.execPath,
    ['-e', `console.log('ready');setInterval(()=>{},1000);`, input.root],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  try {
    await once(running.stdout!, 'data');
    await writeFile(
      join(input.root, 'supervisor', 'owner.json'),
      JSON.stringify({ pid: running.pid, build: input.supervision.build })
    );
    expect(await ensureSharedProcess(input)).toEqual({ created: false });
    expect(running.exitCode).toBeNull();
    await expect(readFile(join(input.root, 'trace'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    if (running.exitCode === null) running.kill('SIGKILL');
  }
});

it('stops the hosts it supervises in-process when closed, and starts no more', async () => {
  const { root, entrypoint } = await fixture();
  await writeFile(
    entrypoint,
    `require('node:fs').writeFileSync(process.argv[2] + '/pid', String(process.pid));
     process.on('message', (m) => { if (m && m.kind === 'switch-stop') process.exit(0); });
     setInterval(() => {}, 1000);`
  );
  const supervision = inProcessSupervision(entrypoint, new SessionLinks());
  await supervision.start({ root, configPath: join(root, 'config.json'), watcher: false });
  const pid = Number(
    await vi.waitFor(async () => await readFile(join(root, 'pid'), 'utf8'), { timeout: 10000 })
  );

  await supervision.close();

  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  await expect(
    supervision.start({ root, configPath: join(root, 'config.json'), watcher: false })
  ).rejects.toThrow('shutting down');
});

/** Launches that start nothing, so what is written to the root can be read. */
const inert = {
  build: 'test',
  links: null,
  start: async () => {},
  stop: async () => {},
};

it('records how a session started when the launch creates it', async () => {
  const input = await fixture();
  await ensureSharedProcess({
    ...input,
    resuming: false,
    restart: false,
    supervision: inert,
    startSource: 'user',
  });

  expect(await owedSessionStart(input.root)).toBe('user');
});

it('records a launcher that said nothing as unknown rather than not at all', async () => {
  const input = await fixture();
  await ensureSharedProcess({ ...input, resuming: false, restart: false, supervision: inert });

  expect(await owedSessionStart(input.root)).toBe('unknown');
});

it('records nothing for a session that already existed', async () => {
  const input = await fixture();
  await writeFile(join(input.root, 'config.json'), JSON.stringify(input.config));
  await ensureSharedProcess({
    ...input,
    resuming: false,
    restart: false,
    supervision: inert,
    startSource: 'room',
  });

  expect(await owedSessionStart(input.root)).toBeNull();
});

it('records nothing for a watcher, which is not a session', async () => {
  const input = await fixture();
  await ensureSharedProcess({
    ...input,
    resuming: false,
    restart: false,
    watcher: true,
    supervision: inert,
    startSource: 'room',
  });

  expect(await owedSessionStart(input.root)).toBeNull();
});

it('starts the session anyway when its start cannot be recorded', async () => {
  const input = await fixture();
  // Something in the way of the record: here, a directory where the file goes.
  await mkdir(join(input.root, 'session-start.json'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const started = vi.fn(async () => {});

  await ensureSharedProcess({
    ...input,
    resuming: false,
    restart: false,
    supervision: { ...inert, start: started },
    startSource: 'user',
  });

  expect(started).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not record how session'));
  // And leaves nothing half-written behind.
  expect(
    (await readdir(input.root)).filter((name) => name.includes('session-start.json.'))
  ).toEqual([]);
  warn.mockRestore();
});

it('kills a host that will not stop for its replacement, with the session hosts under it', async () => {
  // The case that blocked an update: an old watcher waiting forever on a
  // session host that had hung up, so SIGTERM never finished and every
  // replacement gave up with "has not stopped".
  const root = await mkdtemp(join(tmpdir(), 'stop-owned-'));
  const grandchildPid = join(root, 'grandchild.pid');
  const stubborn = spawn(
    process.execPath,
    [
      '-e',
      `process.on('SIGTERM', () => {});
         const child = require('node:child_process').spawn(process.execPath,
           ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
           { detached: true, stdio: 'ignore' });
         require('node:fs').writeFileSync(process.argv[1] + '/grandchild.pid', String(child.pid));
         setInterval(() => {}, 1000);`,
      // On its command line, which is how the stop confirms the pid is still its host.
      root,
    ],
    { detached: true, stdio: 'ignore' }
  );
  try {
    let pid = 0;
    for (let attempt = 0; attempt < 100 && !pid; attempt++) {
      pid = Number(await readFile(grandchildPid, 'utf8').catch(() => '0'));
      if (!pid) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await writeFile(join(root, 'shared-owner.lock'), JSON.stringify({ pid: stubborn.pid }));

    await detachedSupervision('bundle.mjs').stop(root);

    expect(() => process.kill(stubborn.pid!, 0)).toThrow();
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await cleanUp(stubborn.pid);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it('reads a supervisor record left by an earlier process that had this id as no supervisor', async () => {
  // After a container restart the controller has the same low id as the one
  // that wrote the record, so its own id must not read as a live supervisor:
  // nothing would ever start the session again.
  const root = await mkdtemp(join(tmpdir(), 'live-supervisor-reused-pid-'));
  await mkdir(join(root, 'supervisor'), { recursive: true });
  try {
    await writeFile(
      join(root, 'supervisor', 'owner.json'),
      JSON.stringify({ pid: process.pid, token: 'left-by-the-process-before', build: 'b' })
    );
    await expect(liveSupervisor(root)).resolves.toBeNull();
    await writeFile(
      join(root, 'supervisor', 'owner.json'),
      JSON.stringify({ pid: process.ppid, token: 'the-parent-holds-it', build: 'b' })
    );
    await expect(liveSupervisor(root)).resolves.toEqual({ build: 'b' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('reads a record older than the process now holding its id as no supervisor, and stops nothing for it', async () => {
  // Box A, 27 Oct 08:50: each session folder kept a record written on 23 Oct
  // by pid 2. After the box restarted, pid 2 was the controller, so the record
  // read as a live supervisor; stopping that "redefined" session then refused
  // to kill the controller and threw, and every agent host died with it.
  const base = await mkdtemp(join(tmpdir(), 'live-supervisor-stale-'));
  const root = join(base, 'sdk-sessions', 'session-stale');
  const ownerPath = join(root, 'supervisor', 'owner.json');
  await mkdir(join(root, 'supervisor'), { recursive: true });
  const fourDaysAgo = new Date(Date.now() - 4 * 24 * 3600 * 1000);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    // The parent stands in for the controller: alive, and not naming this root.
    await writeFile(ownerPath, JSON.stringify({ pid: process.ppid, token: 't', build: 'b' }));
    await utimes(ownerPath, fourDaysAgo, fourDaysAgo);
    await expect(liveSupervisor(root)).resolves.toBeNull();

    await expect(detachedSupervision('bundle.mjs').stop(root)).resolves.toBeUndefined();
    expect(() => process.kill(process.ppid, 0)).not.toThrow();
    await expect(readFile(ownerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    // The same for a host this process supervises with no entry for the root.
    await writeFile(ownerPath, JSON.stringify({ pid: process.ppid, token: 't', build: 'b' }));
    await utimes(ownerPath, fourDaysAgo, fourDaysAgo);
    const supervision = inProcessSupervision('/nonexistent-entrypoint.mjs', new SessionLinks());
    await expect(supervision.stop(root)).resolves.toBeUndefined();
    await supervision.close();
    expect(() => process.kill(process.ppid, 0)).not.toThrow();
    await expect(readFile(ownerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    // The warning names the session folder only: the full path names the user's home.
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes('sdk-sessions/session-stale'))).toBe(true);
    expect(lines.some((line) => line.includes(base))).toBe(false);
  } finally {
    warn.mockRestore();
    await rm(base, { recursive: true, force: true });
  }
});

it('still refuses to stop a live process that does not name the root when its record is current', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stop-current-stranger-'));
  await mkdir(join(root, 'supervisor'), { recursive: true });
  try {
    await writeFile(
      join(root, 'supervisor', 'owner.json'),
      JSON.stringify({ pid: process.ppid, token: 't', build: 'b' })
    );
    await expect(detachedSupervision('bundle.mjs').stop(root)).rejects.toThrow(
      'The saved PID no longer identifies this SDK host'
    );
    expect(() => process.kill(process.ppid, 0)).not.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('marks every stop its supervisor makes as asked for, and an agent stop on close, but not the controller exiting', async () => {
  const base = await mkdtemp(join(tmpdir(), 'stop-asked-'));
  const stopped = join(base, 'stopped');
  await mkdir(stopped, { recursive: true });
  const supervision = inProcessSupervision('/nonexistent-entrypoint.mjs', new SessionLinks());
  // A session its supervisor stops (a new build, a new definition, deleted or restarted).
  await supervision.stop(stopped);
  expect(await stopWasAsked(stopped)).toBe(true);
  // An upgrade's stop (a new build) is not asked for: the turn it cuts off owes its line.
  const upgraded = join(base, 'upgraded');
  await mkdir(upgraded, { recursive: true });
  await supervision.stop(upgraded, { asked: false });
  expect(await stopWasAsked(upgraded)).toBe(false);
  // Closing for the controller exiting marks nothing; closing for the agent being turned off would.
  const exiting = inProcessSupervision('/nonexistent-entrypoint.mjs', new SessionLinks());
  await exiting.close();
  await exiting.close({ asked: true });
  await rm(base, { recursive: true, force: true });
});
