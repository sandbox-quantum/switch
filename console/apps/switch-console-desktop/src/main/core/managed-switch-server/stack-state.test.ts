import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STACK_HELPER_IMAGE, STACK_STATE_LABEL } from './constants';
import { buildEnvFile } from './env-file';
import type { LocalServerSecrets } from './secret-values';
import {
  inspectStack,
  listProjectResources,
  publishEnv,
  readPublishedEnv,
  type StackStateHost,
  stackStateVolume,
  withdrawPublishedEnv,
} from './stack-state';

const PROJECT = 'switchdash-remote';
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
    sessionDemo: false,
    telemetryEnabled: false,
  });
}

type HostState = {
  /** `service\tstate\tworking_dir` lines, as `docker ps --format` prints them. */
  containers: string[];
  dataVolumes: string[];
  stateVolume: boolean;
  published: string | null;
  own: string | null;
  imagePresent: boolean;
  /** Commands (joined args) that fail. */
  failing: RegExp | null;
  readFileFails: boolean;
};

function fakeHost(initial: Partial<HostState> = {}) {
  const state: HostState = {
    containers: [],
    dataVolumes: [],
    stateVolume: false,
    published: null,
    own: null,
    imagePresent: true,
    failing: null,
    readFileFails: false,
    ...initial,
  };
  const calls: string[][] = [];
  const exec = vi.fn(async (_command: string, args: string[] = []) => {
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
    if (args[0] === 'run') return { stdout: state.published ?? '', stderr: '' };
    throw new Error(`unexpected docker ${joined}`);
  });
  const writeCommandInput = vi.fn(
    async (_command: string, _args: string[], _input: string, _opts: { timeoutMs: number }) => {}
  );
  const host: StackStateHost = {
    ctx: { exec } as unknown as StackStateHost['ctx'],
    dockerBin: 'docker',
    composeProjectName: PROJECT,
    label: 'vm-1',
    workingDir: WORKING_DIR,
    readFile: vi.fn(async () => {
      if (state.readFileFails) throw new Error('Permission denied');
      return state.own;
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
      containers: [`switch\trunning\t${OTHER_DIR}`, `postgres\texited\t${OTHER_DIR}`],
      dataVolumes: [`${PROJECT}_pgdata`, `${PROJECT}_mmdata`],
      stateVolume: true,
    });

    expect(await listProjectResources(host)).toEqual({
      containers: [
        { service: 'switch', state: 'running', workingDir: OTHER_DIR },
        { service: 'postgres', state: 'exited', workingDir: OTHER_DIR },
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
    const { host } = fakeHost({ containers: ['switch\trunning\t'] });

    const { containers } = await listProjectResources(host);

    expect(containers).toEqual([{ service: 'switch', state: 'running', workingDir: null }]);
  });
});

describe('the published copy', () => {
  it('is read through a throwaway container that mounts the volume read-only', async () => {
    const env = envFor();
    const { host, calls } = fakeHost({ stateVolume: true, published: env });

    expect(await readPublishedEnv(host)).toBe(env);
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

  it('reads as absent when the volume holds no copy', async () => {
    const { host } = fakeHost({ stateVolume: true, published: '' });

    expect(await readPublishedEnv(host)).toBeNull();
  });

  it('pulls the helper image on a host that does not have it yet', async () => {
    const { host, calls } = fakeHost({
      stateVolume: true,
      published: envFor(),
      imagePresent: false,
    });

    await readPublishedEnv(host);

    expect(calls.map((args) => args[0])).toEqual(['image', 'pull', 'run']);
  });

  it('is published on stdin and never as an argument, which every account could read', async () => {
    const env = envFor();
    const { host, calls, writeCommandInput } = fakeHost();

    await publishEnv(host, env);

    expect(calls).toContainEqual([
      'volume',
      'create',
      '--label',
      `${STACK_STATE_LABEL}=${PROJECT}`,
      `${PROJECT}_console-state`,
    ]);
    expect(writeCommandInput).toHaveBeenCalledOnce();
    const [, args, input] = writeCommandInput.mock.calls[0]!;
    expect(input).toBe(env);
    expect(args.join(' ')).not.toContain(secrets.gatewayAdminPassword);
    expect(args.join(' ')).not.toContain(secrets.dbPassword);
    expect(args).toEqual(
      expect.arrayContaining(['--interactive', `${PROJECT}_console-state:/state`])
    );
    // Written aside and moved into place, so a reader never sees half a file.
    expect(args.join(' ')).toMatch(/umask 077 && cat > .*\.tmp.* && mv /);
    for (const argv of calls) expect(argv.join(' ')).not.toContain(secrets.jwtSecretKey);
  });

  it('is withdrawn on reset, and only it: the activity record survives', async () => {
    const { host, writeCommandInput } = fakeHost({ stateVolume: true });

    await withdrawPublishedEnv(host);

    const [, args] = writeCommandInput.mock.calls[0]!;
    const script = args[args.indexOf('-c') + 1]!;
    expect(script).toContain('rm -f "/state/stack.env"');
    expect(script).not.toMatch(/rm -rf|activity/);
  });

  it('has nothing to withdraw, and creates nothing, when the volume was never made', async () => {
    const { host, writeCommandInput, calls } = fakeHost();

    await withdrawPublishedEnv(host);

    expect(writeCommandInput).not.toHaveBeenCalled();
    expect(calls.some((args) => args[1] === 'create')).toBe(false);
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

  it('reads a leftover working-dir file on an otherwise empty host as a stopped stack', async () => {
    const { host } = fakeHost({ own: envFor() });

    expect(await inspectStack(host)).toMatchObject({
      kind: 'present',
      source: 'working-dir',
      running: false,
    });
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

  it('names what a partial published copy is missing', async () => {
    const { host } = fakeHost({
      stateVolume: true,
      published: envFor().replace(/^JWT_SECRET_KEY=.*$/m, ''),
    });

    expect(await inspectStack(host)).toEqual({
      kind: 'incomplete',
      source: 'published',
      missing: ['JWT_SECRET_KEY'],
      running: false,
    });
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
