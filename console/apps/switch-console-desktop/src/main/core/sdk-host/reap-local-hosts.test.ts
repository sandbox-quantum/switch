import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  base: vi.fn(),
  agents: vi.fn(),
  remote: vi.fn(),
}));

vi.mock('./local-host', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  localStateBase: mocks.base,
}));
vi.mock('@main/core/agents/getAgents', () => ({ getAgents: mocks.agents }));
vi.mock('@main/core/agents/agent-location', () => ({ getRemoteAgentLocation: mocks.remote }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));

const { reapDetachedLocalWatchers } = await import('./reap-local-hosts');

const bases: string[] = [];
let base: string;

beforeEach(async () => {
  vi.clearAllMocks();
  base = await mkdtemp(join(tmpdir(), 'reap-watchers-'));
  bases.push(base);
  mocks.base.mockReturnValue(base);
  mocks.agents.mockResolvedValue([
    { id: 'agent-1', locationId: 'location-1', switchAgentId: 'switch-agent-1' },
  ]);
  mocks.remote.mockResolvedValue(null);
});
afterEach(async () => {
  for (const directory of bases.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** A stand-in for the detached watcher: it exits once watch.json turns false. */
async function detachedWatcher(root: string) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const fs=require('node:fs');const root=process.argv[1];
       fs.writeFileSync(root+'/shared-owner.lock',JSON.stringify({pid:process.pid}));
       console.log('ready');
       setInterval(()=>{
         if(!JSON.parse(fs.readFileSync(root+'/watch.json','utf8')).enabled){
           fs.unlinkSync(root+'/shared-owner.lock');process.exit(0);
         }
       },20);`,
      root,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  await new Promise((resolve) => child.stdout!.once('data', resolve));
  return child;
}

async function watcherRoot(switchAgentId: string) {
  const root = join(base, 'root-for-' + switchAgentId);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'config.json'),
    JSON.stringify({ session: { agentId: switchAgentId } })
  );
  await writeFile(join(root, 'watch.json'), JSON.stringify({ enabled: true }));
  return root;
}

it.skipIf(process.platform === 'win32')(
  'stops a detached watcher an earlier build left running for a local agent',
  async () => {
    const root = await watcherRoot('switch-agent-1');
    const child = await detachedWatcher(root);
    try {
      await reapDetachedLocalWatchers();
      await expect.poll(() => child.exitCode).not.toBeNull();
      expect(JSON.parse(await readFile(join(root, 'watch.json'), 'utf8'))).toEqual({
        enabled: false,
      });
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
);

it.skipIf(process.platform === 'win32')('leaves a remote agent’s watcher running', async () => {
  mocks.remote.mockResolvedValue({ sshHost: 'builder' });
  const root = await watcherRoot('switch-agent-1');
  const child = await detachedWatcher(root);
  try {
    await reapDetachedLocalWatchers();
    expect(child.exitCode).toBeNull();
    expect(JSON.parse(await readFile(join(root, 'watch.json'), 'utf8'))).toEqual({ enabled: true });
  } finally {
    child.kill('SIGKILL');
  }
});

it.skipIf(process.platform === 'win32')(
  'ignores a saved PID that now belongs to an unrelated process',
  async () => {
    const root = await watcherRoot('switch-agent-1');
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
    });
    await writeFile(join(root, 'shared-owner.lock'), JSON.stringify({ pid: unrelated.pid }));
    try {
      await reapDetachedLocalWatchers();
      expect(JSON.parse(await readFile(join(root, 'watch.json'), 'utf8'))).toEqual({
        enabled: true,
      });
    } finally {
      unrelated.kill('SIGKILL');
    }
  }
);

it('leaves a root alone when no agent claims it rather than guessing', async () => {
  const root = await watcherRoot('switch-agent-unknown');
  await reapDetachedLocalWatchers();
  expect(JSON.parse(await readFile(join(root, 'watch.json'), 'utf8'))).toEqual({ enabled: true });
});

it('does nothing when no watcher state was ever written', async () => {
  mocks.base.mockReturnValue(join(base, 'missing'));
  await expect(reapDetachedLocalWatchers()).resolves.toBeUndefined();
});
