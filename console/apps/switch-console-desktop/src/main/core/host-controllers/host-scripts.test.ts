import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ENROLL_SCRIPT,
  enrollResultSchema,
  nodeIsNewEnough,
  PREPARE_SCRIPT,
  prepareResultSchema,
  START_SCRIPT,
  STATUS_SCRIPT,
  statusResultSchema,
  STOP_SCRIPT,
  SUPERVISOR_SCRIPT,
  systemdUnit,
} from './host-scripts';

const execute = promisify(execFile);

/**
 * Stands in for the controller bundle: `enroll` prints what the real one
 * prints, and `run` does what `mode` in its data directory says — stay up
 * until stopped, fail once and then stay up, or exit as revoked.
 */
const FAKE_CONTROLLER = String.raw`
const fs = require('node:fs'), path = require('node:path');
const [command, ...rest] = process.argv.slice(2);
const flag = (name) => rest[rest.indexOf(name) + 1];
if (command === 'enroll') {
  if (flag('--code') === 'bad') { process.stderr.write('switch-agent-controller: The enrollment code is invalid or expired.\n'); process.exit(2); }
  process.stdout.write('Enrolled as controller ctl-1 ("' + flag('--name') + '") on ' + flag('--server') + '.\n');
  process.exit(0);
}
const dataDir = flag('--data-dir');
const mode = fs.readFileSync(path.join(dataDir, 'mode'), 'utf8').trim();
const runs = path.join(dataDir, 'runs');
fs.appendFileSync(runs, 'run\n');
if (mode === 'revoked') process.exit(3);
if (mode === 'fail-once' && fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean).length === 1) process.exit(1);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`;

let home: string;
let bundle: string;

async function run(script: string, options: unknown): Promise<unknown> {
  const { stdout } = await execute(process.execPath, ['-e', script, JSON.stringify(options)], {
    env: { ...process.env, HOME: home },
  });
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
}

function dataDir(): string {
  return join(home, '.local', 'state', 'switch', 'agent-controller', 'console-server-1');
}

const startedPids: number[] = [];

function runs(): number {
  try {
    return readFileSync(join(dataDir(), 'runs'), 'utf8').trim().split('\n').length;
  } catch {
    return 0;
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'host-scripts-'));
  bundle = join(home, 'fake-controller.cjs');
  writeFileSync(bundle, FAKE_CONTROLLER);
});

afterEach(async () => {
  for (const pid of startedPids.splice(0))
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  await delay(100);
  rmSync(home, { recursive: true, force: true });
});

describe('looking the host over', () => {
  it('says whether this build’s bundle is there, and removes other builds’ bundles', async () => {
    const directory = join(home, '.local', 'state', 'switch', 'sdk-host');
    const hash = createHash('sha256').update('controller').digest('hex');
    const first = prepareResultSchema.parse(
      await run(PREPARE_SCRIPT, { bundleName: `agent-controller-${hash}.mjs`, hash })
    );
    expect(first).toMatchObject({ present: false, directory, home, node: process.versions.node });
    writeFileSync(join(directory, `agent-controller-${hash}.mjs`), 'controller');
    const stale = `agent-controller-${'b'.repeat(64)}.mjs`;
    writeFileSync(join(directory, stale), 'old');
    const second = prepareResultSchema.parse(
      await run(PREPARE_SCRIPT, { bundleName: `agent-controller-${hash}.mjs`, hash })
    );
    expect(second.present).toBe(true);
    expect(existsSync(join(directory, stale))).toBe(false);
  });

  it('knows which Node can run the controller', () => {
    expect(nodeIsNewEnough('22.13.0')).toBe(true);
    expect(nodeIsNewEnough('24.1.0')).toBe(true);
    expect(nodeIsNewEnough('22.12.1')).toBe(false);
    expect(nodeIsNewEnough('20.18.0')).toBe(false);
  });
});

describe('enrolling', () => {
  it('reports the controller it enrolled as', async () => {
    const result = enrollResultSchema.parse(
      await run(ENROLL_SCRIPT, {
        node: process.execPath,
        bundle,
        server: 'https://switch.example.com',
        code: 'swce_good',
        name: 'build-box',
        dataDir: '~/.local/state/switch/agent-controller/console-server-1',
      })
    );
    expect(result).toEqual({ ok: true, controllerId: 'ctl-1' });
  });

  it('reports why, when the controller refuses', async () => {
    const result = enrollResultSchema.parse(
      await run(ENROLL_SCRIPT, {
        node: process.execPath,
        bundle,
        server: 'https://switch.example.com',
        code: 'bad',
        name: 'build-box',
        dataDir: '~/x',
      })
    );
    expect(result).toEqual({ ok: false, reason: 'The enrollment code is invalid or expired.' });
  });
});

describe('the detached supervisor', () => {
  const args = () => ({
    node: process.execPath,
    bundle,
    dataDir: '~/.local/state/switch/agent-controller/console-server-1',
    sharedHost: '~/shared-host.mjs',
    path: process.env.PATH ?? '',
  });

  async function start(mode: string): Promise<void> {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(join(dataDir(), 'mode'), mode);
    const started = (await run(START_SCRIPT, {
      supervision: 'detached',
      unit: 'unused.service',
      unitText: '',
      supervisor: SUPERVISOR_SCRIPT,
      args: args(),
    })) as { pid: number };
    startedPids.push(started.pid);
  }

  async function status() {
    return statusResultSchema.parse(
      await run(STATUS_SCRIPT, { supervision: 'detached', unit: 'unused', dataDir: args().dataDir })
    );
  }

  async function until(check: () => Promise<boolean>, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out');
      await delay(100);
    }
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it('keeps the controller running, and stops it and its agents on request', async () => {
    await start('up');
    await until(async () => (await status()).running, 5_000);
    const supervisor = startedPids.at(-1)!;
    mkdirSync(join(dataDir(), 'watchers', 'agent-1'), { recursive: true });
    writeFileSync(join(dataDir(), 'controller.db'), '');
    mkdirSync(join(dataDir(), 'secrets'), { recursive: true });
    const stopped = (await run(STOP_SCRIPT, {
      supervision: 'detached',
      unit: 'unused',
      dataDir: args().dataDir,
      turnOff: true,
      wipe: true,
    })) as { turnedOff: number };
    expect(stopped.turnedOff).toBe(1);
    expect(alive(supervisor)).toBe(false);
    expect((await status()).running).toBe(false);
    expect(
      JSON.parse(readFileSync(join(dataDir(), 'watchers', 'agent-1', 'watch.json'), 'utf8'))
    ).toEqual({ enabled: false, spawn: false });
    expect(existsSync(join(dataDir(), 'controller.db'))).toBe(false);
    expect(existsSync(join(dataDir(), 'secrets'))).toBe(false);
  });

  it('stops without wiping, and can be started again, as a restart does', async () => {
    await start('up');
    await until(async () => (await status()).running, 5_000);
    const first = startedPids.at(-1)!;
    await run(STOP_SCRIPT, {
      supervision: 'detached',
      unit: 'unused',
      dataDir: args().dataDir,
      turnOff: false,
      wipe: false,
    });
    expect(alive(first)).toBe(false);
    expect(await status()).toMatchObject({ running: false, state: 'stopped' });
    await start('up');
    await until(async () => (await status()).running, 5_000);
  });

  it('starts the controller again after an error that may pass', async () => {
    await start('fail-once');
    await until(async () => runs() === 2, 12_000);
    await until(async () => (await status()).running, 2_000);
  }, 20_000);

  it('leaves a revoked controller stopped, and says so', async () => {
    await start('revoked');
    await until(async () => (await status()).state === 'exited', 5_000);
    expect(await status()).toMatchObject({ running: false, state: 'exited', code: 3 });
    await delay(300);
    expect(runs()).toBe(1);
  });

  it('refuses to start a second supervisor', async () => {
    await start('up');
    await until(async () => (await status()).running, 5_000);
    await expect(start('up')).rejects.toThrow(/already running/);
  });
});

describe('the systemd unit', () => {
  it('runs the controller with the host’s PATH and restarts it only on exit code 1', () => {
    const unit = systemdUnit({
      description: 'Switch agents controller',
      node: '/usr/bin/node',
      bundle: '/home/ada/.local/state/switch/sdk-host/agent-controller-x.mjs',
      dataDir: '/home/ada/.local/state/switch/agent-controller/console-server-1',
      sharedHost: '/home/ada/.local/state/switch/sdk-host/shared-host-y.mjs',
      path: '/home/ada/.local/bin:/usr/bin',
    });
    expect(unit).toContain(
      'ExecStart="/usr/bin/node" "/home/ada/.local/state/switch/sdk-host/agent-controller-x.mjs" "run" "--data-dir" "/home/ada/.local/state/switch/agent-controller/console-server-1" "--shared-host-bundle" "/home/ada/.local/state/switch/sdk-host/shared-host-y.mjs"'
    );
    expect(unit).toContain('Environment="PATH=/home/ada/.local/bin:/usr/bin"');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartPreventExitStatus=2 3 4');
  });
});
