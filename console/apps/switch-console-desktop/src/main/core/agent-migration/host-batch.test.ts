import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteFiles, readFiles, stopWatchers } from './host-batch';
import type { MachineScript } from './session-handoff';

const execute = promisify(execFile);

let home: string;
const children: ChildProcess[] = [];

/** `node -e` with `home` as its home directory, as the scripts run on a host. */
const run: MachineScript = async (script, args) =>
  (
    await execute(process.execPath, ['-e', script, ...args], {
      env: { ...process.env, HOME: home },
    })
  ).stdout;

const rootOf = (identity: string) =>
  join(
    home,
    '.local',
    'state',
    'switch',
    'sdk-watchers',
    createHash('sha256').update(identity).digest('hex')
  );

/** A stand-in watcher: a process whose command line names the shared host, recorded as the root's owner. */
async function watcher(
  identity: string,
  behaviour: 'exits-when-off' | 'ignores-sigterm' | 'not-ours'
) {
  const root = rootOf(identity);
  await mkdir(join(root, 'supervisor'), { recursive: true });
  await writeFile(join(root, 'config.json'), JSON.stringify({ session: { agentId: identity } }));
  await writeFile(join(root, 'watch.json'), JSON.stringify({ enabled: true }));
  const body = {
    'exits-when-off': `const fs=require('fs');setInterval(()=>{if(!JSON.parse(fs.readFileSync(process.argv[1]+'/watch.json','utf8')).enabled)process.exit(0)},100)`,
    'ignores-sigterm': `process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`,
    'not-ours': `setInterval(()=>{},1000)`,
  }[behaviour];
  const name = behaviour === 'not-ours' ? 'something-else' : 'shared-host-test.mjs';
  const child = spawn(process.execPath, ['-e', body, root, name], { stdio: 'ignore' });
  children.push(child);
  await writeFile(join(root, 'shared-owner.lock'), JSON.stringify({ pid: child.pid }));
  return child;
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'host-batch-'));
});

afterEach(async () => {
  for (const child of children.splice(0)) if (!exited(child)) child.kill('SIGKILL');
  await rm(home, { recursive: true, force: true });
});

describe('stopping several watchers at once', () => {
  it('turns each off and waits for them together', async () => {
    const a = await watcher('agent-a', 'exits-when-off');
    const b = await watcher('agent-b', 'exits-when-off');
    const outcome = await stopWatchers(run, ['agent-a', 'agent-b', 'agent-none'], {
      waitMs: 5_000,
      killWaitMs: 1_000,
    });
    expect(outcome).toEqual({ 'agent-a': null, 'agent-b': null, 'agent-none': null });
    expect(JSON.parse(await readFile(join(rootOf('agent-a'), 'watch.json'), 'utf8'))).toEqual({
      enabled: false,
      spawn: false,
    });
    await expect.poll(() => exited(a) && exited(b)).toBe(true);
  });

  it('kills a watcher that does not stop by itself', async () => {
    const stuck = await watcher('agent-stuck', 'ignores-sigterm');
    const outcome = await stopWatchers(run, ['agent-stuck'], { waitMs: 300, killWaitMs: 300 });
    expect(outcome).toEqual({ 'agent-stuck': null });
    await expect.poll(() => exited(stuck)).toBe(true);
  });

  it('never signals a process that is not a watcher, and says the watcher is still up', async () => {
    const other = await watcher('agent-other', 'not-ours');
    const outcome = await stopWatchers(run, ['agent-other'], { waitMs: 200, killWaitMs: 200 });
    expect(outcome['agent-other']).toMatch(/did not stop/);
    expect(exited(other)).toBe(false);
  });
});

describe('credentials files on a host', () => {
  it('reads several in one command, and removes the ones asked', async () => {
    const one = join(home, 'one.json');
    const two = join(home, 'two.json');
    await writeFile(one, '{"a":1}');
    expect(await readFiles(run, [one, two])).toEqual({ [one]: '{"a":1}', [two]: null });
    await deleteFiles(run, [one, two]);
    expect(await readFiles(run, [one])).toEqual({ [one]: null });
  });
});
