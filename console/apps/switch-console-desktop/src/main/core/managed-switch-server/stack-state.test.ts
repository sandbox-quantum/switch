import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '@main/core/execution-context/types';
import { STACK_HELPER_IMAGE, STACK_STATE_LABEL } from './constants';
import { buildEnvFile } from './env-file';
import type { LocalServerSecrets } from './secret-values';
import type { ServerLease } from './stack-lock';
import {
  driftOf,
  inspectStack,
  listProjectResources,
  probeFromStack,
  publishEnv,
  readPublishedCopy,
  readStateVolume,
  runStateScript,
  type StackStateHost,
  stackStateVolume,
  stampPublishedEnv,
  withdrawPublishedEnv,
} from './stack-state';
import { LOCK_LOST_MESSAGE, WHILE_HOLDING_SERVER_LOCK } from './state-mutex';
import { stateScriptEnv } from './test-helpers/state-script-shell';

const PROJECT = 'switchdash-remote';
/** The server lock as the start holding it passes it on. */
const lease = { token: 'lease-token' } as ServerLease;
const WORKING_DIR = '/home/bob/.switchdash/switch-server';
const OTHER_DIR = '/home/alice/.switchdash/switch-server';

const secrets: LocalServerSecrets = {
  dbPassword: 'db-pw',
  dbRuntimePassword: 'db-runtime-pw',
  agentRegistrationToken: 'agent-token',
  jwtSecretKey: 'jwt-key',
  gatewayAdminPassword: 'gw-admin',
  mattermostAdminPassword: 'mm-admin',
  mattermostUserPassword: 'mm-user',
};
const ports = { gateway: 51000, api: 51001, mattermost: 51002, postgres: 51003 };

function envFor(overrides: Partial<LocalServerSecrets> = {}, version = '0.27.0'): string {
  return buildEnvFile({
    version,
    registry: 'ghcr.io',
    namespace: 'sandbox-quantum',
    ports,
    secrets: { ...secrets, ...overrides },
    telemetryEnabled: false,
  });
}

type HostState = {
  /** `service\tstate\tworking_dir` lines, as `docker ps --format` prints them. */
  containers: string[];
  dataVolumes: string[];
  stateVolume: boolean;
  published: string | null;
  /** The database volume the published copy says it was written for. */
  publishedStamp: string | null;
  /** When the daemon says the database volume was created. */
  databaseCreatedAt: string;
  own: string | null;
  /** What this account's `.env.db` says, or null for none. */
  ownStamp: string | null;
  imagePresent: boolean;
  /** Commands (joined args) that fail. */
  failing: RegExp | null;
  readFileFails: boolean;
};

/** The `docker run` the state launcher execs, from the arguments it is given. */
function dockerRun(launcherArgs: string[]): string[] {
  const [, , , , image = '', , , , , mount = '', stdin = '', script = '', ...rest] = launcherArgs;
  return [
    'run',
    '--rm',
    ...(stdin === 'yes' ? ['--interactive'] : []),
    '--network',
    'none',
    '--volume',
    mount,
    '--entrypoint',
    'sh',
    image,
    '-c',
    script,
    'stack-state',
    ...rest,
  ];
}

function fakeHost(initial: Partial<HostState> = {}) {
  const state: HostState = {
    containers: [],
    dataVolumes: [],
    stateVolume: false,
    published: null,
    publishedStamp: null,
    databaseCreatedAt: '2026-09-01T10:00:00Z',
    own: null,
    ownStamp: null,
    imagePresent: true,
    failing: null,
    readFileFails: false,
    ...initial,
  };
  const calls: string[][] = [];
  /** The state launcher, as the host's shell would run it: its image check,
   * its volume creation, and then the `docker run` it execs. */
  const launch = (args: string[]): string[] => {
    const [, , , , , volume = '', label = '', create = ''] = args;
    if (!state.imagePresent) {
      throw Object.assign(new Error('exit 97'), {
        stderr: 'switch-console: the helper image is not on this host',
      });
    }
    if (create === 'yes') {
      calls.push(['volume', 'create', '--label', label, volume]);
      state.stateVolume = true;
    }
    return dockerRun(args);
  };
  const exec = vi.fn(async (command: string, args: string[] = []): Promise<ExecResult> => {
    if (command === 'sh') args = launch(args);
    calls.push(args);
    const joined = args.join(' ');
    if (state.failing?.test(joined)) {
      throw Object.assign(new Error('exit 1'), { stderr: 'Cannot connect to the Docker daemon' });
    }
    if (args[0] === 'ps') return { stdout: state.containers.join('\n'), stderr: '' };
    if (args[0] === 'volume' && args[1] === 'ls') {
      const filter = args[args.indexOf('--filter') + 1]!;
      if (filter.startsWith(`label=${STACK_STATE_LABEL}=`)) {
        return { stdout: state.stateVolume ? `${PROJECT}_console-state\n` : '', stderr: '' };
      }
      return { stdout: state.dataVolumes.join('\n'), stderr: '' };
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      return { stdout: `${state.databaseCreatedAt}\n`, stderr: '' };
    }
    if (args[0] === 'volume' && args[1] === 'create') {
      state.stateVolume = true;
      return { stdout: `${PROJECT}_console-state\n`, stderr: '' };
    }
    if (args[0] === 'image') {
      if (!state.imagePresent)
        throw Object.assign(new Error('exit 1'), { stderr: 'No such image' });
      return { stdout: 'sha256:abc\n', stderr: '' };
    }
    if (args[0] === 'pull') {
      state.imagePresent = true;
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'run') {
      return {
        stdout: `${state.published ?? ''}\n---switch-console-stamp---\n${state.publishedStamp ?? ''}\n`,
        stderr: '',
      };
    }
    throw new Error(`unexpected docker ${joined}`);
  });
  const writeCommandInput = vi.fn(
    async (_command: string, args: string[], _input: string, _opts: { timeoutMs: number }) => {
      calls.push(launch(args));
    }
  );
  const host: StackStateHost = {
    ctx: { exec } as unknown as StackStateHost['ctx'],
    dockerBin: 'docker',
    composeProjectName: PROJECT,
    label: 'vm-1',
    workingDir: WORKING_DIR,
    readFile: vi.fn(async (path: string) => {
      if (state.readFileFails) throw new Error('Permission denied');
      return path === '.env.db' ? state.ownStamp : state.own;
    }),
    writeCommandInput,
  };
  return { host, state, calls, exec, writeCommandInput };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the helper image', () => {
  it('is the stack’s own Postgres image, so a host that ran the stack already has it', () => {
    const compose = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        'resources/standalone-docker-compose.pinned.yml'
      ),
      'utf8'
    );
    const postgres = /^ {2}postgres:\n(?: {4}.*\n)*? {4}image: (\S+)$/m.exec(compose);

    expect(postgres?.[1]).toBe(STACK_HELPER_IMAGE);
  });
});

describe('listProjectResources', () => {
  it('finds the project by label, so another account’s stack is seen without its compose file', async () => {
    const { host, calls } = fakeHost({
      containers: [
        `switch\trunning\t${OTHER_DIR}\tghcr.io/sandbox-quantum/switch-core:0.28.0`,
        `postgres\texited\t${OTHER_DIR}\tpostgres:16-alpine`,
      ],
      dataVolumes: [`${PROJECT}_pgdata`, `${PROJECT}_mmdata`],
      stateVolume: true,
    });

    expect(await listProjectResources(host)).toEqual({
      containers: [
        {
          service: 'switch',
          state: 'running',
          workingDir: OTHER_DIR,
          image: 'ghcr.io/sandbox-quantum/switch-core:0.28.0',
        },
        {
          service: 'postgres',
          state: 'exited',
          workingDir: OTHER_DIR,
          image: 'postgres:16-alpine',
        },
      ],
      dataVolumes: [`${PROJECT}_pgdata`, `${PROJECT}_mmdata`],
      stateVolume: true,
    });
    for (const args of calls) expect(args).not.toContain('-f');
    expect(calls[0]).toEqual(
      expect.arrayContaining(['--all', `label=com.docker.compose.project=${PROJECT}`])
    );
  });

  it('reads a container without a working-dir label as unknown rather than empty', async () => {
    const { host } = fakeHost({ containers: ['switch\trunning\t\tswitch-core:0.28.0'] });

    const { containers } = await listProjectResources(host);

    expect(containers).toEqual([
      { service: 'switch', state: 'running', workingDir: null, image: 'switch-core:0.28.0' },
    ]);
  });
});

describe('the published copy', () => {
  it('is read through a throwaway container that mounts the volume read-only', async () => {
    const env = envFor();
    const { host, calls } = fakeHost({ stateVolume: true, published: env });

    expect(await readPublishedCopy(host)).toEqual({ env, stamp: null });
    const run = calls.find((args) => args[0] === 'run')!;
    expect(run).toEqual(
      expect.arrayContaining([
        '--rm',
        '--network',
        'none',
        `${stackStateVolume(host)}:/state:ro`,
        STACK_HELPER_IMAGE,
      ])
    );
  });

  it('reads a copy written before stamps existed as unstamped', async () => {
    const env = envFor();
    const { host, exec } = fakeHost({ stateVolume: true });
    exec.mockImplementation(async (command: string, args: string[] = []) => {
      if (command === 'sh') return { stdout: env, stderr: '' };
      throw new Error(`unexpected docker ${args.join(' ')}`);
    });

    expect(await readPublishedCopy(host)).toEqual({ env, stamp: null });
  });

  it('reads as absent when the volume holds no copy', async () => {
    const { host } = fakeHost({ stateVolume: true, published: '' });

    expect(await readPublishedCopy(host)).toBeNull();
  });

  it('pulls a missing helper image under a pull’s timeout, then runs, in one trip each time', async () => {
    // Not pulled by `docker run` inside a timeout meant for a quick script: a
    // host whose image was pruned may take minutes to fetch it.
    const { host, calls, exec } = fakeHost({
      stateVolume: true,
      published: envFor(),
      imagePresent: false,
    });

    await readPublishedCopy(host);
    await readPublishedCopy(host);

    expect(calls.map((args) => args[0])).toEqual(['pull', 'run', 'run']);
    expect(exec).toHaveBeenCalledWith(
      'docker',
      ['pull', '--quiet', STACK_HELPER_IMAGE],
      expect.objectContaining({ timeout: 10 * 60_000 })
    );
  });

  it('is published on stdin and never as an argument, which every account could read', async () => {
    const env = envFor();
    const { host, calls, writeCommandInput } = fakeHost();

    await publishEnv(host, env, lease);

    expect(calls).toContainEqual([
      'volume',
      'create',
      '--label',
      `${STACK_STATE_LABEL}=${PROJECT}`,
      `${PROJECT}_console-state`,
    ]);
    expect(writeCommandInput).toHaveBeenCalledOnce();
    const [, launched, input] = writeCommandInput.mock.calls[0]!;
    const args = dockerRun(launched);
    // No database volume yet (a first start), so an empty stamp line.
    expect(input).toBe(`\n${env}`);
    expect(args.join(' ')).not.toContain(secrets.gatewayAdminPassword);
    expect(args.join(' ')).not.toContain(secrets.dbPassword);
    expect(args).toEqual(
      expect.arrayContaining(['--interactive', `${PROJECT}_console-state:/state`])
    );
    // Written aside and moved into place, so a reader never sees half a file.
    const script = args[args.indexOf('-c') + 1]!;
    expect(script).toMatch(/umask 077\n.*\ncat > .*stack\.env\.tmp.*\nmv /s);
    expect(script).toContain('rm -f "/state/stack.db"');
    for (const argv of calls) expect(argv.join(' ')).not.toContain(secrets.jwtSecretKey);
  });

  it('is published only while the lock is still this start’s, checked in the same step', async () => {
    const { host, writeCommandInput } = fakeHost();

    await publishEnv(host, envFor(), lease);

    const args = dockerRun(writeCommandInput.mock.calls[0]![1]);
    expect(args.slice(args.indexOf('-c') + 2)).toEqual(['stack-state', lease.token]);
    expect(args[args.indexOf('-c') + 1]).toContain(WHILE_HOLDING_SERVER_LOCK);
  });

  it('reads the database volume it was written for, when that was recorded', async () => {
    const env = envFor();
    const { host } = fakeHost({
      stateVolume: true,
      published: env,
      publishedStamp: '2026-09-01T10:00:00Z',
    });

    expect(await readPublishedCopy(host)).toEqual({ env, stamp: '2026-09-01T10:00:00Z' });
  });

  it('is stamped with the database volume it is published for, when there is one', async () => {
    const env = envFor();
    const { host, writeCommandInput } = fakeHost({ dataVolumes: [`${PROJECT}_pgdata`] });

    await publishEnv(host, env, lease);

    const [, , input] = writeCommandInput.mock.calls[0]!;
    expect(input).toBe(`2026-09-01T10:00:00Z\n${env}`);
  });

  it('is left unstamped, and says so, when a start leaves no database volume to stamp it with', async () => {
    const { host, writeCommandInput } = fakeHost({ stateVolume: true, dataVolumes: [] });

    await stampPublishedEnv(host, lease);

    expect(writeCommandInput).not.toHaveBeenCalled();
  });

  it('is stamped after a first start, once the database volume exists', async () => {
    const { host, writeCommandInput } = fakeHost({
      stateVolume: true,
      dataVolumes: [`${PROJECT}_pgdata`, `${PROJECT}_mmdata`],
    });

    await stampPublishedEnv(host, lease);

    const [, launched, input] = writeCommandInput.mock.calls[0]!;
    const args = dockerRun(launched);
    expect(input).toBe('2026-09-01T10:00:00Z\n');
    expect(args[args.indexOf('-c') + 1]).toContain('/state/stack.db');
  });

  it('is withdrawn on reset, and only it: the activity record survives', async () => {
    const { host, writeCommandInput } = fakeHost({ stateVolume: true });

    await withdrawPublishedEnv(host, lease);

    const args = dockerRun(writeCommandInput.mock.calls[0]![1]);
    const script = args[args.indexOf('-c') + 1]!;
    expect(script).toContain('rm -f "/state/stack.env"');
    expect(script).toContain('"/state/stack.db"');
    expect(script).not.toMatch(/rm -rf|activity/);
  });

  it('has nothing to withdraw, and creates nothing, when the volume was never made', async () => {
    const { host, writeCommandInput, calls } = fakeHost();

    await withdrawPublishedEnv(host, lease);

    expect(writeCommandInput).not.toHaveBeenCalled();
    expect(calls.some((args) => args[1] === 'create')).toBe(false);
  });
});

describe('the published copy’s scripts, run for real', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stack-state-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A host whose state volume is `dir`, with every script run by `sh`. */
  function realHost(initial: Partial<HostState> = {}) {
    const fake = fakeHost({ stateVolume: true, ...initial });
    // Held by the start doing the writing, as the supervisor would have it.
    writeFileSync(join(dir, 'lock'), `switch-console-lock v1\n${lease.token}\n`);
    const env = stateScriptEnv();
    const sh = (args: string[], input: string) => {
      const run = dockerRun(args);
      const at = run.indexOf('-c');
      const script = run[at + 1]!.replaceAll('/state', dir);
      return execFileSync('sh', ['-c', script, ...run.slice(at + 2)], {
        input,
        encoding: 'utf8',
        env,
      });
    };
    fake.writeCommandInput.mockImplementation(async (_command, args, input) => {
      sh(args, input);
    });
    const exec = fake.exec.getMockImplementation()!;
    fake.exec.mockImplementation(async (command: string, args: string[] = []) =>
      command === 'sh' ? { stdout: sh(args, ''), stderr: '' } : exec(command, args)
    );
    return fake;
  }

  it('reads back exactly the copy and stamp it wrote', async () => {
    const env = envFor();
    const { host } = realHost({ dataVolumes: [`${PROJECT}_pgdata`] });

    await publishEnv(host, env, lease);

    expect(await readPublishedCopy(host)).toEqual({ env, stamp: '2026-09-01T10:00:00Z' });
  });

  it('drops an earlier stamp when publishing for a database not created yet', async () => {
    const { host, state } = realHost({ dataVolumes: [`${PROJECT}_pgdata`] });
    await publishEnv(host, envFor({ dbPassword: 'first' }), lease);

    // Reset: the volume is gone when the next start publishes.
    state.dataVolumes = [];
    const env = envFor({ dbPassword: 'second' });
    await publishEnv(host, env, lease);

    expect(await readPublishedCopy(host)).toEqual({ env, stamp: null });

    // And compose creates it; the start then stamps the copy with it.
    state.dataVolumes = [`${PROJECT}_pgdata`];
    state.databaseCreatedAt = '2026-09-24T12:00:00Z';
    await stampPublishedEnv(host, lease);

    expect(await readPublishedCopy(host)).toEqual({ env, stamp: '2026-09-24T12:00:00Z' });
  });

  it('writes nothing once another Console has taken the lock over', async () => {
    const { host } = realHost({ dataVolumes: [`${PROJECT}_pgdata`] });
    await publishEnv(host, envFor({ dbPassword: 'theirs' }), lease);
    const stale = { token: 'token-this-console-lost' } as ServerLease;

    await expect(publishEnv(host, envFor({ dbPassword: 'mine' }), stale)).rejects.toThrow(
      LOCK_LOST_MESSAGE
    );
    await expect(stampPublishedEnv(host, stale)).rejects.toThrow(LOCK_LOST_MESSAGE);
    await expect(withdrawPublishedEnv(host, stale)).rejects.toThrow(LOCK_LOST_MESSAGE);

    expect(await readPublishedCopy(host)).toMatchObject({ env: envFor({ dbPassword: 'theirs' }) });
  });

  it('withdraws the copy and its stamp together', async () => {
    const { host } = realHost({ dataVolumes: [`${PROJECT}_pgdata`] });
    await publishEnv(host, envFor(), lease);

    await withdrawPublishedEnv(host, lease);

    expect(await readPublishedCopy(host)).toBeNull();
    expect(() => readFileSync(join(dir, 'stack.db'))).toThrow(/ENOENT/);
  });
});

describe('inspectStack', () => {
  it('reports a host with nothing of the stack as absent', async () => {
    const { host } = fakeHost();

    expect(await inspectStack(host)).toEqual({ kind: 'absent' });
  });

  it('prefers the published copy, and says whether the stack is up', async () => {
    const env = envFor();
    const { host } = fakeHost({
      containers: [`switch\trunning\t${OTHER_DIR}`],
      dataVolumes: [`${PROJECT}_pgdata`],
      stateVolume: true,
      published: env,
    });

    expect(await inspectStack(host)).toMatchObject({
      kind: 'present',
      source: 'published',
      running: true,
      published: true,
      raw: env,
      env: { ports, secrets, version: '0.27.0' },
    });
  });

  it('takes the published copy over a stale one left in this account’s working dir', async () => {
    // Someone else reset and restarted the stack: its credentials are new, and
    // the file this account wrote before that opens nothing.
    const { host } = fakeHost({
      containers: [`switch\trunning\t${OTHER_DIR}`],
      stateVolume: true,
      published: envFor({ dbPassword: 'new-owner-pw' }),
      own: envFor({ dbPassword: 'stale-owner-pw' }),
    });

    const stack = await inspectStack(host);

    expect(stack.kind === 'present' && stack.env.secrets.dbPassword).toBe('new-owner-pw');
  });

  it('trusts a published copy written for the database that is there', async () => {
    const env = envFor();
    const { host } = fakeHost({
      containers: [`switch\trunning\t${OTHER_DIR}`],
      dataVolumes: [`${PROJECT}_pgdata`],
      stateVolume: true,
      published: env,
      publishedStamp: '2026-09-01T10:00:00Z',
    });

    expect(await inspectStack(host)).toMatchObject({ kind: 'present', source: 'published' });
  });

  it('ignores a published copy written for a database that has since been recreated', async () => {
    // A Console from before settings were shared reset the stack from another
    // account and started it with new credentials, leaving the copy behind.
    const { host } = fakeHost({
      containers: [`switch\trunning\t${OTHER_DIR}`],
      dataVolumes: [`${PROJECT}_pgdata`],
      stateVolume: true,
      published: envFor({ dbPassword: 'before-the-reset' }),
      publishedStamp: '2026-09-01T10:00:00Z',
      databaseCreatedAt: '2026-09-20T08:30:00Z',
    });

    expect(await inspectStack(host)).toEqual({
      kind: 'unshared',
      ownerDir: OTHER_DIR,
      running: true,
    });
  });

  it('falls back to this account’s own settings past a stale published copy', async () => {
    const own = envFor({ dbPassword: 'after-the-reset' });
    const { host } = fakeHost({
      containers: [`switch\trunning\t${WORKING_DIR}`],
      dataVolumes: [`${PROJECT}_pgdata`],
      stateVolume: true,
      published: envFor({ dbPassword: 'before-the-reset' }),
      publishedStamp: '2026-09-01T10:00:00Z',
      databaseCreatedAt: '2026-09-20T08:30:00Z',
      own,
    });

    const stack = await inspectStack(host);

    expect(stack).toMatchObject({ kind: 'present', source: 'working-dir', published: false });
    expect(stack.kind === 'present' && stack.env.secrets.dbPassword).toBe('after-the-reset');
  });

  it('reads this account’s own stack, not yet published, from its working dir', async () => {
    const env = envFor();
    const { host } = fakeHost({
      containers: [`switch\texited\t${WORKING_DIR}`],
      dataVolumes: [`${PROJECT}_pgdata`],
      own: env,
    });

    expect(await inspectStack(host)).toMatchObject({
      kind: 'present',
      source: 'working-dir',
      running: false,
      published: false,
      raw: env,
    });
  });

  it('treats settings with no stack behind them as a first start', async () => {
    // What a reset leaves: this account's `.env`, and possibly a published copy
    // from a Console that did not withdraw it. Their credentials open nothing,
    // and a stopped stack that "keeps its data" is not what is there.
    const { host } = fakeHost({ own: envFor(), stateVolume: true, published: envFor() });

    expect(await inspectStack(host)).toEqual({ kind: 'absent' });
  });

  it('refuses to take another account’s unpublished stack for this one', async () => {
    const { host } = fakeHost({
      containers: [`switch\trunning\t${OTHER_DIR}`],
      dataVolumes: [`${PROJECT}_pgdata`],
      own: envFor({ dbPassword: 'stale' }),
    });

    expect(await inspectStack(host)).toEqual({
      kind: 'unshared',
      ownerDir: OTHER_DIR,
      running: true,
    });
  });

  it('treats data with no containers and no readable settings as someone else’s', async () => {
    const { host } = fakeHost({ dataVolumes: [`${PROJECT}_pgdata`] });

    expect(await inspectStack(host)).toEqual({ kind: 'unshared', ownerDir: null, running: false });
  });

  it('treats data with no containers as this account’s when it has the settings', async () => {
    // A stack stopped by an older Console: `compose down` removed its
    // containers, and it never published.
    const { host } = fakeHost({ dataVolumes: [`${PROJECT}_pgdata`], own: envFor() });

    expect(await inspectStack(host)).toMatchObject({ kind: 'present', source: 'working-dir' });
  });

  it('trusts this account’s settings written for the database that is there', async () => {
    const { host } = fakeHost({
      dataVolumes: [`${PROJECT}_pgdata`],
      own: envFor(),
      ownStamp: '2026-09-01T10:00:00Z\n',
    });

    expect(await inspectStack(host)).toMatchObject({
      kind: 'present',
      source: 'working-dir',
      stamp: '2026-09-01T10:00:00Z',
    });
  });

  it('does not take this account’s settings for a database since recreated elsewhere', async () => {
    // A Console that does not share its settings reset the stack, started it
    // with its own credentials and took its containers down: this account's
    // copy opens nothing, and starting from it would lock that database out.
    const { host } = fakeHost({
      dataVolumes: [`${PROJECT}_pgdata`],
      own: envFor(),
      ownStamp: '2026-08-01T09:00:00Z\n',
      databaseCreatedAt: '2026-09-20T08:30:00Z',
    });

    expect(await inspectStack(host)).toEqual({ kind: 'unshared', ownerDir: null, running: false });
  });

  it('asks about the database once when both copies need comparing with it', async () => {
    const { host, calls } = fakeHost({
      dataVolumes: [`${PROJECT}_pgdata`],
      stateVolume: true,
      published: envFor(),
      publishedStamp: '2026-08-01T09:00:00Z',
      own: envFor(),
      ownStamp: '2026-08-01T09:00:00Z\n',
      databaseCreatedAt: '2026-09-20T08:30:00Z',
    });

    expect(await inspectStack(host)).toMatchObject({ kind: 'unshared' });
    expect(calls.filter((args) => args[0] === 'volume' && args[1] === 'inspect')).toHaveLength(1);
  });

  it('cannot tell whose settings they are when the database cannot be asked about', async () => {
    const { host } = fakeHost({
      dataVolumes: [`${PROJECT}_pgdata`],
      own: envFor(),
      ownStamp: '2026-08-01T09:00:00Z\n',
      failing: /^volume inspect/,
    });

    expect(await inspectStack(host)).toMatchObject({ kind: 'unreadable' });
  });

  it('names what a partial published copy is missing', async () => {
    const partial = envFor().replace(/^JWT_SECRET_KEY=.*$/m, '');
    const { host } = fakeHost({
      dataVolumes: [`${PROJECT}_pgdata`],
      stateVolume: true,
      published: partial,
    });

    expect(await inspectStack(host)).toEqual({
      kind: 'incomplete',
      source: 'published',
      missing: ['JWT_SECRET_KEY'],
      raw: partial,
      running: false,
    });
  });

  it('says what failed when the daemon gives no reason of its own', async () => {
    const { host, exec } = fakeHost();
    exec.mockRejectedValue(new Error('channel closed'));

    expect(await inspectStack(host)).toMatchObject({
      kind: 'unreadable',
      reason: expect.stringContaining('channel closed'),
    });
  });

  it('says what failed when the failure is not even an Error', async () => {
    const { host, exec } = fakeHost();
    exec.mockRejectedValue('connection reset by peer');

    expect(await inspectStack(host)).toMatchObject({
      kind: 'unreadable',
      reason: expect.stringContaining('connection reset by peer'),
    });
  });

  it('trusts a stamped copy as before when the database volume names no creation time', async () => {
    const env = envFor();
    const { host } = fakeHost({
      containers: [`switch\trunning\t${WORKING_DIR}\tghcr.io/x/switch-core:0.11.0`],
      dataVolumes: [`${PROJECT}_pgdata`],
      stateVolume: true,
      published: env,
      publishedStamp: '2026-09-01T10:00:00Z',
      databaseCreatedAt: '',
    });

    expect(await inspectStack(host)).toMatchObject({ kind: 'present', source: 'published' });
  });

  it('reports a daemon it cannot ask as unreadable, never as absent', async () => {
    const { host } = fakeHost({ failing: /^ps/ });

    const stack = await inspectStack(host);

    expect(stack.kind).toBe('unreadable');
    expect(stack.kind === 'unreadable' && stack.reason).toMatch(/vm-1.*Cannot connect/);
  });

  it('reports a working dir it cannot read as unreadable, never as absent', async () => {
    const { host } = fakeHost({ readFileFails: true });

    expect(await inspectStack(host)).toEqual({
      kind: 'unreadable',
      reason: 'Permission denied',
    });
  });
});

describe('the version a stack runs', () => {
  it('is read from the image of its running core, beside the version its settings ask for', async () => {
    // A start that published and then failed leaves the old containers
    // running: what they run is what the stack is.
    const { host } = fakeHost({
      containers: [
        `switch\trunning\t${OTHER_DIR}\tghcr.io/sandbox-quantum/switch-core:0.26.0`,
        `postgres\trunning\t${OTHER_DIR}\tpostgres:16-alpine`,
      ],
      dataVolumes: [`${PROJECT}_pgdata`],
      stateVolume: true,
      published: envFor({}, '0.27.0'),
    });

    expect(await inspectStack(host)).toMatchObject({
      kind: 'present',
      runningVersion: '0.26.0',
      env: { version: '0.27.0' },
    });
  });

  it('is not known from containers that are not running', async () => {
    const { host } = fakeHost({
      containers: [`switch\texited\t${OTHER_DIR}\tghcr.io/sandbox-quantum/switch-core:0.26.0`],
      dataVolumes: [`${PROJECT}_pgdata`],
      stateVolume: true,
      published: envFor(),
    });

    expect(await inspectStack(host)).toMatchObject({ kind: 'present', runningVersion: null });
  });
});

describe('what the setup step is told about a host', () => {
  const present = {
    kind: 'present' as const,
    env: { ports, secrets, version: '0.27.0' },
    raw: 'RAW\n',
    source: 'published' as const,
    running: true,
    published: true,
    runningVersion: null,
    stamp: null,
  };

  it('compares the version a running stack runs, else the one its settings name', () => {
    expect(driftOf({ ...present, runningVersion: '0.26.0' })).toMatchObject({
      deployed: '0.26.0',
    });
    expect(driftOf(present)).toMatchObject({ deployed: '0.27.0' });
    expect(driftOf({ ...present, env: { ...present.env, version: null } })).toBeNull();
  });

  it('reports the version the stack runs, and never a secret', () => {
    const probe = probeFromStack('vm-1', { ...present, runningVersion: '0.26.0' }, null);

    expect(probe).toMatchObject({ kind: 'present', deployedVersion: '0.26.0', shared: true });
    expect(JSON.stringify(probe)).not.toContain(secrets.gatewayAdminPassword);
  });

  it('says an unshared stack is another account’s even when it cannot say whose', () => {
    const probe = probeFromStack(
      'vm-1',
      { kind: 'unshared', ownerDir: null, running: false },
      null
    );

    expect(probe.kind === 'unshared' && probe.message).toMatch(
      /^The Switch server on vm-1 was set up from another account and its settings have not been shared/
    );
  });

  it('names where another account’s unshared stack was started from', () => {
    const probe = probeFromStack(
      'vm-1',
      {
        kind: 'unshared',
        ownerDir: OTHER_DIR,
        running: true,
      },
      null
    );

    expect(probe).toMatchObject({ kind: 'unshared', running: true, ownerDir: OTHER_DIR });
    expect(probe.kind === 'unshared' && probe.message).toMatch(
      /set up from another account \(from \/home\/alice\/\.switchdash\/switch-server\)/
    );
  });

  it('passes on what a partial stack is missing, a reason it could not look, and an empty host', () => {
    expect(
      probeFromStack(
        'vm-1',
        {
          kind: 'incomplete',
          source: 'published',
          missing: ['JWT_SECRET_KEY'],
          raw: 'JWT_SECRET_KEY=\n',
          running: false,
        },
        null
      )
    ).toEqual({ kind: 'incomplete', running: false, missing: ['JWT_SECRET_KEY'] });
    expect(probeFromStack('vm-1', { kind: 'unreadable', reason: 'ssh dropped' }, null)).toEqual({
      kind: 'unreadable',
      reason: 'ssh dropped',
    });
    expect(probeFromStack('vm-1', { kind: 'absent' }, null)).toEqual({
      kind: 'absent',
      busy: null,
    });
  });

  it('passes on who is changing the stack right now, for Start or Connect to wait for', () => {
    const busy = {
      name: 'bob@desk',
      hostAccount: 'bob',
      action: 'starting' as const,
      heldForSeconds: 30,
      expiresInSeconds: 90,
    };

    expect(probeFromStack('vm-1', { kind: 'absent' }, busy)).toEqual({ kind: 'absent', busy });
    expect(probeFromStack('vm-1', present, busy)).toMatchObject({ kind: 'present', busy });
  });
});

describe('the state launcher, run for real', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'state-launcher-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A host whose shell is this machine's and whose docker is a script that
   * records what it was asked, and has the helper image only when told to. */
  function launcherHost(imagePresent: boolean, ownImage: string | null = null) {
    const log = join(dir, 'docker.log');
    const docker = join(dir, 'docker');
    writeFileSync(
      docker,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> '${log}'`,
        `if [ "$1" = image ] && [ "$3" = '${STACK_HELPER_IMAGE}' ]; then ${imagePresent ? 'exit 0' : 'exit 1'}; fi`,
        `if [ "$1" = image ]; then [ "$3" = '${ownImage ?? ''}' ] && exit 0; exit 1; fi`,
        `if [ "$1" = ps ]; then echo '${ownImage ?? ''}'; exit 0; fi`,
        'if [ "$1" = run ]; then echo ran; fi',
        'exit 0',
      ].join('\n'),
      { mode: 0o755 }
    );
    const { host } = fakeHost();
    const real: StackStateHost = {
      ...host,
      dockerBin: docker,
      ctx: {
        exec: async (command: string, args: string[] = []) => {
          try {
            return { stdout: execFileSync(command, args, { encoding: 'utf8' }), stderr: '' };
          } catch (error) {
            const stderr = (error as { stderr?: Buffer | string }).stderr?.toString() ?? '';
            throw Object.assign(new Error('exit'), { stderr });
          }
        },
      } as unknown as StackStateHost['ctx'],
    };
    const asked = () => readFileSync(log, 'utf8').trim().split('\n');
    return { host: real, asked };
  }

  it('checks the image, creates the volume labelled, and runs, in one command', async () => {
    const { host, asked } = launcherHost(true);

    expect((await runStateScript(host, 'echo hi', ['arg one'])).trim()).toBe('ran');

    const [image, create, run] = asked();
    expect(image).toBe(`image inspect ${STACK_HELPER_IMAGE}`);
    expect(create).toBe(
      `volume create --label ${STACK_STATE_LABEL}=${PROJECT} ${PROJECT}_console-state`
    );
    expect(run).toMatch(/^run --rm --network none --volume \S+_console-state:\/state /);
    expect(run).toMatch(/-c echo hi stack-state arg one$/);
  });

  it('creates nothing for a read', async () => {
    const { host, asked } = launcherHost(true);

    await readStateVolume(host, 'cat /state/x');

    expect(asked().some((line) => line.startsWith('volume create'))).toBe(false);
    expect(asked().at(-1)).toMatch(/_console-state:\/state:ro /);
  });

  it('runs in the stack’s own Postgres image on a host without the helper image', async () => {
    // Stop and Reset take the lock too: a host that cannot pull the helper
    // image still has the image its stack's database runs.
    const { host, asked } = launcherHost(false, 'postgres:17-alpine');

    await runStateScript(host, 'echo hi', []);

    expect(asked().at(-1)).toMatch(/--entrypoint sh postgres:17-alpine -c echo hi/);
    expect(asked().some((line) => line.startsWith('pull'))).toBe(false);
  });

  it('says the helper image is missing rather than letting docker run pull it', async () => {
    const { host, asked } = launcherHost(false);

    // The pull goes to the fake docker as well, which "succeeds" without
    // fetching anything, so the retry finds the image still missing.
    await expect(runStateScript(host, 'echo hi', [])).rejects.toThrow(
      /helper image is not on this host/
    );
    expect(asked().filter((line) => line.startsWith('run'))).toEqual([]);
  });
});
