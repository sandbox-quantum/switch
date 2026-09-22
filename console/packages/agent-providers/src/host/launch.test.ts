import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { detachedSupervision, ensureSharedProcess } from './launch';
import type { SharedHostConfig } from './shared-config';

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
  };
}
it('refuses to replace missing conversation state with a fresh session', async () => {
  await expect(ensureSharedProcess(await fixture())).rejects.toThrow('no saved SDK conversation');
});
it.skipIf(process.platform === 'win32')(
  'waits for the old owner to exit before starting its replacement',
  async () => {
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
        `const fs=require('node:fs');const root=process.argv[1];fs.writeFileSync(root+'/shared-owner.lock',JSON.stringify({pid:process.pid}));process.on('SIGTERM',()=>{setTimeout(()=>{fs.appendFileSync(root+'/trace','old-stopped\\n');process.exit(0)},200)});console.log('ready');setInterval(()=>{},1000);`,
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
  }
);

it('refreshes renamed agent configuration without changing the saved session or room', async () => {
  const input = await fixture();
  input.restart = false;
  input.config.start.input.agentName = 'old-name';
  input.config.roomConnection = { connectionId: 'connection', rooms: ['room'] };
  await writeFile(join(input.root, 'config.json'), JSON.stringify(input.config));
  await mkdir(join(input.root, 'supervisor'));
  await writeFile(
    join(input.root, 'supervisor', 'owner.json'),
    JSON.stringify({ pid: process.pid, build: input.supervision.build })
  );
  input.config = structuredClone(input.config);
  input.config.start.input.agentName = 'new-name';
  input.config.session.hostId = 'proposed-new-host';
  input.config.roomConnection = { connectionId: 'new-connection', rooms: [] };
  expect(await ensureSharedProcess(input)).toEqual({ created: false });
  const saved = JSON.parse(await readFile(join(input.root, 'config.json'), 'utf8'));
  expect(saved.start.input.agentName).toBe('new-name');
  expect(saved.session.hostId).toBe('host');
  expect(saved.roomConnection).toEqual({
    connectionId: 'connection',
    rooms: ['room'],
  });
});

it('gives a controller the connection it was asked for rather than the one on disk', async () => {
  const input = await fixture();
  input.restart = false;
  input.watcher = true;
  input.config.roomConnection = { connectionId: 'written-at-first-launch', rooms: [] };
  await writeFile(join(input.root, 'config.json'), JSON.stringify(input.config));
  await mkdir(join(input.root, 'supervisor'));
  await writeFile(
    join(input.root, 'supervisor', 'owner.json'),
    JSON.stringify({ pid: process.pid, build: input.supervision.build })
  );
  input.config = structuredClone(input.config);
  input.config.roomConnection = { connectionId: 'derived-from-the-agent', rooms: [] };
  expect(await ensureSharedProcess(input)).toEqual({ created: false });
  const saved = JSON.parse(await readFile(join(input.root, 'config.json'), 'utf8'));
  expect(saved.roomConnection).toEqual({ connectionId: 'derived-from-the-agent', rooms: [] });
});

it.skipIf(process.platform === 'win32')(
  'replaces a supervisor an earlier deployment left running',
  async () => {
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
      ['-e', `console.log('ready');setInterval(()=>{},1000);`, input.root],
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
  }
);

it.skipIf(process.platform === 'win32')(
  'leaves a supervisor running the deployed build alone',
  async () => {
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
  }
);
