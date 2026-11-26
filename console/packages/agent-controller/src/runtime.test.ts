import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  bundleIdentity,
  type OpenAgentStream,
  readSharedCredentials,
} from '@switch-console/agent-providers';
import {
  SERVICE_ACCOUNT_KEY_FIXTURE,
  vertexCredentialFixture,
} from '@switch-console/agent-providers/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from './log';
import { dataLayout } from './paths';
import {
  clearLeftLoginChecks,
  type InProcessBox,
  InProcessRuntime,
  isInside,
  LaunchedBundle,
  loginProbeEnvironment,
  observeOnDisk,
  parseRelayCredentials,
  probeProvider,
  relayCredentialsBody,
} from './runtime';
import { buildWatcherTemplate } from './template';

/** Stands in for the shared-host bundle: answers `--probe`. Sessions are never started here. */
const FAKE_BUNDLE = `
const args = process.argv.slice(2);
if (args[0] === '--probe') {
  console.log('noise first');
  console.log(JSON.stringify({ status: 'authenticated', message: args.join(' '), models: [] }));
}
`;

const RELAY = {
  endpoint: 'http://127.0.0.1:43210',
  token: 'swlr_relay-token-placeholder',
  hub: 'ws://127.0.0.1:43210/hub',
  providerLogin: null,
};
const LAUNCH = {
  isolation: 'shared' as const,
  restart: false,
  replaceIdentity: false,
  clearTakenOver: false,
};

let dir: string;
let bundle: string;
let runtime: InProcessRuntime;
let home: string | undefined;
let opened: { agentId: string; scope: string; filter: string; signal: AbortSignal }[];
let attempts: number;
let failOpens: number;
const children: ChildProcess[] = [];

/** The controller's end of each watcher's stream: it records the open and never delivers anything. */
function openStream(agentId: string): OpenAgentStream {
  return (deps) => {
    attempts++;
    if (failOpens > 0) {
      failOpens--;
      throw new Error('stream refused');
    }
    opened.push({ agentId, scope: deps.scope, filter: deps.filter, signal: deps.signal });
    return {
      announcesSessionStarts: true,
      placementsNameCallRooms: true,
      start: () => {},
      setSpawnCapable: () => {},
      replacePlacements: async () => ({ refusedRooms: [] }),
    };
  };
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await delay(10);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controller-runtime-'));
  home = process.env.HOME;
  process.env.HOME = join(dir, 'home');
  bundle = join(dir, 'fake-bundle.cjs');
  writeFileSync(bundle, FAKE_BUNDLE);
  opened = [];
  attempts = 0;
  failOpens = 0;
  runtime = new InProcessRuntime({
    layout: dataLayout(join(dir, 'data')),
    workspaces: join(dir, 'data', 'workspaces'),
    bundlePath: bundle,
    openStream,
    log: silentLogger,
    crashBackoffMs: 5,
    box: null,
  });
});

afterEach(async () => {
  await runtime.close();
  for (const child of children) child.kill('SIGKILL');
  children.length = 0;
  process.env.HOME = home;
  rmSync(dir, { recursive: true, force: true });
});

function template(cwd = '/work/scout', provider: 'claude' | 'codex' = 'claude') {
  return buildWatcherTemplate({
    agentId: 'agent-1',
    provider,
    definition: {
      name: 'scout',
      model: null,
      advanced_config: {},
      instructions: '',
      auto_approve: false,
      auto_mode: false,
    },
    cwd,
    credentialsPath: runtime.credentialsPath('agent-1', 'claude'),
    binaryPath: null,
  });
}

/** A process whose command line names the watcher root, as a detached watcher's does. */
async function fakeWatcher(root: string): Promise<ChildProcess> {
  // Stops as an agent host does: on SIGTERM, or on Windows when its stop file appears.
  const script = `const { existsSync } = require('node:fs');
    const stop = require('node:path').join(process.argv[1], '.stop-' + process.pid);
    setInterval(() => { if (existsSync(stop)) process.exit(0); }, 100);`;
  const child = spawn(process.execPath, ['-e', script, root], { stdio: 'ignore' });
  children.push(child);
  await once(child, 'spawn');
  return child;
}

describe('InProcessRuntime', () => {
  it('writes credentials the shared host reads, owner-only, outside the working directory', async () => {
    await runtime.writeCredentials('agent-1', RELAY);
    const path = runtime.credentialsPath('agent-1', 'claude');
    expect(path).toBe(join(dir, 'data', 'agents', 'agent-1', 'credentials.json'));
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    if (process.platform !== 'win32')
      expect(statSync(join(dir, 'data', 'agents', 'agent-1')).mode & 0o777).toBe(0o700);
    expect(await readSharedCredentials(template())).toEqual({
      SWITCH_API_ENDPOINT: 'http://127.0.0.1:43210',
      SWITCH_API_TOKEN: 'swlr_relay-token-placeholder',
      SWITCH_AGENT_ID: 'agent-1',
      SWITCH_AGENT_HUB: 'ws://127.0.0.1:43210/hub',
    });
    expect(await runtime.readCredentials('agent-1')).toEqual(RELAY);
    await runtime.deleteCredentials('agent-1');
    await runtime.deleteCredentials('agent-1');
    expect(await runtime.readCredentials('agent-1')).toBeNull();
  });

  it('runs the watcher in this process, from a template written as its configuration', async () => {
    await runtime.writeCredentials('agent-1', RELAY);
    await runtime.launch('agent-1', template(), LAUNCH);
    const root = join(dir, 'data', 'watchers', 'agent-1');
    expect(JSON.parse(readFileSync(join(root, 'watch.json'), 'utf8'))).toEqual({
      enabled: true,
      spawn: true,
    });
    await waitFor(() => opened.length === 1, 'the watcher to open its stream');
    expect(opened[0]).toMatchObject({ agentId: 'agent-1', scope: 'all', filter: 'addressed' });
    const observation = await runtime.observe('agent-1');
    expect(observation).toMatchObject({
      alive: true,
      configured: { provider: 'claude', cwd: '/work/scout' },
      flags: { enabled: true, spawn: true },
      failure: null,
      takenOver: null,
    });
    expect(observation.health).toMatchObject({ pid: process.pid, current: true });
    await waitFor(
      () => existsSync(join(dir, 'data', 'watchers', 'agent-1', 'health.json')),
      'the health file'
    );
    expect(await observeOnDisk(dataLayout(join(dir, 'data')), 'agent-1', null)).toMatchObject({
      alive: true,
      health: { pid: process.pid, current: true },
    });

    await runtime.stop('agent-1', { wait: true });
    expect(await runtime.observe('agent-1')).toMatchObject({
      alive: false,
      flags: { enabled: false, spawn: false },
      health: null,
    });
    expect(opened[0]!.signal.aborted).toBe(true);
  });

  it('restarts into a new provider or directory, replacing the saved configuration', async () => {
    await runtime.writeCredentials('agent-1', RELAY);
    await runtime.launch('agent-1', template(), LAUNCH);
    await waitFor(() => opened.length === 1, 'the first watcher');
    await runtime.launch('agent-1', template('/work/elsewhere', 'codex'), {
      isolation: 'shared',
      restart: true,
      replaceIdentity: true,
      clearTakenOver: true,
    });
    await waitFor(() => opened.length === 2, 'the second watcher');
    expect(opened[0]!.signal.aborted).toBe(true);
    expect(await runtime.observe('agent-1')).toMatchObject({
      alive: true,
      configured: { provider: 'codex', cwd: '/work/elsewhere' },
    });
  });

  it('starts a failed watcher again, and records its failure once it keeps failing', async () => {
    await runtime.writeCredentials('agent-1', RELAY);
    failOpens = 10;
    await runtime.launch('agent-1', template(), LAUNCH);
    await waitFor(() => attempts === 4, 'four attempts');
    await waitFor(
      () => existsSync(join(dir, 'data', 'watchers', 'agent-1', 'supervisor', 'failure.json')),
      'the failure recorded'
    );
    const observation = await runtime.observe('agent-1');
    expect(observation.alive).toBe(false);
    expect(observation.failure).toMatch(/stream refused/);
    await delay(100);
    expect(attempts).toBe(4);
  });

  it('stops a watcher an earlier controller left running as a process of its own', async () => {
    const root = join(dir, 'data', 'watchers', 'agent-1');
    mkdirSync(join(root, 'supervisor'), { recursive: true });
    const detached = await fakeWatcher(root);
    writeFileSync(join(root, 'supervisor', 'owner.json'), JSON.stringify({ pid: detached.pid }));
    await runtime.writeCredentials('agent-1', RELAY);
    await runtime.launch('agent-1', template(), LAUNCH);
    expect(detached.exitCode !== null || detached.signalCode !== null).toBe(true);
    await waitFor(() => opened.length === 1, 'the watcher in this process');
  });

  it('stops every watcher when closed', async () => {
    await runtime.writeCredentials('agent-1', RELAY);
    await runtime.launch('agent-1', template(), LAUNCH);
    await waitFor(() => opened.length === 1, 'the watcher');
    await runtime.close();
    expect(opened[0]!.signal.aborted).toBe(true);
    expect((await runtime.observe('agent-1')).alive).toBe(false);
  });

  it('reads a recorded failure and a stand-down marker', async () => {
    const root = join(dir, 'data', 'watchers', 'agent-1');
    mkdirSync(join(root, 'supervisor'), { recursive: true });
    writeFileSync(join(root, 'supervisor', 'failure.json'), JSON.stringify({ message: 'boom' }));
    writeFileSync(
      join(root, 'taken-over.json'),
      JSON.stringify({ at: 'x', reason: 'y', connectionId: 'z' })
    );
    expect(await runtime.observe('agent-1')).toMatchObject({
      alive: false,
      failure: 'boom',
      takenOver: { reason: 'y' },
    });
  });

  it('probes a provider through the bundle', async () => {
    const readiness = await runtime.probe('claude', '/usr/bin/claude', '/tmp', null);
    expect(readiness).toEqual({
      status: 'authenticated',
      message: '--probe claude /tmp /usr/bin/claude',
      models: [],
    });
  });

  it('probes a Vertex AI login with its Google credential written in a directory of its own', async () => {
    const checkDir = join(dir, 'login-check', 'claude');
    const env = await loginProbeEnvironment(
      checkDir,
      {
        status: 'connected',
        provider: 'claude',
        revision: '1',
        kind: 'vertex',
        credential: vertexCredentialFixture(),
      },
      '/usr/bin/claude'
    );
    const path = join(checkDir, 'provider-home', 'google-credentials.json');
    expect(env).toEqual({
      CLAUDE_CODE_USE_VERTEX: '1',
      ANTHROPIC_VERTEX_PROJECT_ID: 'acme-ai',
      CLOUD_ML_REGION: 'global',
      GOOGLE_APPLICATION_CREDENTIALS: path,
    });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(SERVICE_ACCOUNT_KEY_FIXTURE);
  });

  it('removes the copy of a given login it checked, once checked', async () => {
    const seen = join(dir, 'seen-login.cjs');
    writeFileSync(
      seen,
      `const { existsSync } = require('node:fs');
       const auth = require('node:path').join(process.env.CODEX_HOME, 'auth.json');
       console.log(JSON.stringify({ status: 'authenticated', message: String(existsSync(auth)), models: [] }));`
    );
    const checking = new InProcessRuntime({
      layout: dataLayout(join(dir, 'data')),
      workspaces: join(dir, 'data', 'workspaces'),
      bundlePath: seen,
      openStream,
      log: silentLogger,
      crashBackoffMs: 5,
      box: null,
    });
    const readiness = await checking.probe('codex', '/usr/bin/codex', '/tmp', {
      status: 'connected',
      provider: 'codex',
      revision: '1',
      kind: 'auth-json',
      credential: '{"tokens":{"access_token":"fixture-token"}}',
    });
    // Written for the check, and gone after it.
    expect(readiness.message).toBe('true');
    expect(existsSync(join(dir, 'data', 'login-check', 'codex'))).toBe(false);
  });

  it('removes a given login’s files and token from the agent’s directory when it goes', async () => {
    await runtime.writeCredentials('agent-1', RELAY);
    await runtime.launch('agent-1', template(), LAUNCH);
    await runtime.stop('agent-1', { wait: true });
    const root = join(dir, 'data', 'watchers', 'agent-1');
    const auth = join(root, 'provider-home', 'auth.json');
    mkdirSync(join(root, 'provider-home'), { recursive: true });
    writeFileSync(auth, 'login-placeholder');
    writeFileSync(`${auth}.switch-credential`, 'fingerprint');
    const saved = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
    saved.start.input.env = { ...saved.start.input.env, ANTHROPIC_API_KEY: 'sk-given' };
    writeFileSync(join(root, 'config.json'), JSON.stringify(saved));
    await runtime.deleteCredentials('agent-1');
    expect(existsSync(auth)).toBe(false);
    expect(existsSync(`${auth}.switch-credential`)).toBe(false);
    const env = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).start.input.env;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('resolves working directories', async () => {
    expect(await runtime.workingDirectory('agent-1', 'scout', null)).toBe(
      join(dir, 'data', 'workspaces', 'scout')
    );
    expect(statSync(join(dir, 'data', 'workspaces', 'scout')).isDirectory()).toBe(true);
    expect(await runtime.workingDirectory('agent-1', 'scout', dir)).toBe(dir);
    await expect(
      runtime.workingDirectory('agent-1', 'scout', 'relative/dir')
    ).rejects.toMatchObject({
      reason: 'definition_invalid',
    });
    await expect(
      runtime.workingDirectory('agent-1', 'scout', join(dir, 'missing'))
    ).rejects.toMatchObject({
      reason: 'definition_invalid',
    });
    await expect(runtime.workingDirectory('agent-1', 'scout', bundle)).rejects.toMatchObject({
      reason: 'definition_invalid',
    });
  });

  it('makes a missing directory inside the workspaces directory, and only there', async () => {
    const named = join(dir, 'data', 'workspaces', 'chosen', 'nested');
    expect(await runtime.workingDirectory('agent-1', 'scout', named)).toBe(named);
    expect(statSync(named).isDirectory()).toBe(true);
    const escaping = join(dir, 'data', 'workspaces', '..', 'outside');
    await expect(runtime.workingDirectory('agent-1', 'scout', escaping)).rejects.toMatchObject({
      reason: 'definition_invalid',
    });
    expect(existsSync(join(dir, 'data', 'outside'))).toBe(false);
    await expect(
      runtime.workingDirectory('agent-1', 'scout', join(dir, 'data', 'workspaces'))
    ).resolves.toBe(join(dir, 'data', 'workspaces'));
  });
});

describe('LaunchedBundle', () => {
  const health = (bundle: string | undefined, current = true) => ({
    state: 'connected' as const,
    detail: null,
    since: new Date(0).toISOString(),
    placements: {},
    pid: 4242,
    updatedAt: new Date(0).toISOString(),
    current,
    ...(bundle === undefined ? {} : { bundle }),
  });

  it('says a live agent host on another bundle, or one that names none, is outdated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'launched-bundle-'));
    try {
      const path = join(dir, 'shared-host.mjs');
      await writeFile(path, 'console.log(1);');
      const launched = new LaunchedBundle(path);
      const ours = await bundleIdentity(path);
      expect(await launched.outdates(health(ours))).toBe(false);
      expect(await launched.outdates(health('another'))).toBe(true);
      expect(await launched.outdates(health(undefined))).toBe(true);
      expect(await launched.outdates(health('another', false))).toBe(false);
      expect(await launched.outdates(null)).toBe(false);

      await writeFile(path, 'console.log(22);');
      expect(await launched.outdates(health(ours))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('box mode (InProcessBox)', () => {
  function fakeBox(overrides: Partial<InProcessBox> = {}): InProcessBox & {
    watchers: string[];
    supervised: string[];
  } {
    const watchers: string[] = [];
    const supervised: string[] = [];
    return {
      watchers,
      supervised,
      watcher: (agentId) => {
        watchers.push(agentId);
        return undefined;
      },
      supervision: (agentId) => {
        supervised.push(agentId);
        return {
          judge: async () => ({ kind: 'alive' as const }),
          ticketJudge: async () => ({ kind: 'alive' as const }),
          selfRestart: true,
          recordFolder: (path: string) => path,
          commandLine: async () => null,
          markStopAsked: async () => {},
          extraEnv: { SWITCH_TEST_OWNER: agentId },
        } as unknown as ReturnType<InProcessBox['supervision']>;
      },
      recordedOwnerAlive: async () => true,
      judgeOwnerRecord: async () => ({ kind: 'alive' }),
      ...overrides,
    };
  }

  function boxRuntime(box: InProcessBox): InProcessRuntime {
    return new InProcessRuntime({
      layout: dataLayout(join(dir, 'data')),
      workspaces: join(dir, 'data', 'workspaces'),
      bundlePath: bundle,
      openStream,
      log: silentLogger,
      crashBackoffMs: 5,
      box,
    });
  }

  it("gives each agent host the box's watcher and supervision halves", async () => {
    const box = fakeBox();
    const inBox = boxRuntime(box);
    await inBox.writeCredentials('agent-1', RELAY);
    await inBox.launch('agent-1', template(), LAUNCH);
    await waitFor(() => opened.length === 1, 'the watcher');
    expect(box.watchers).toEqual(['agent-1']);
    expect(box.supervised).toEqual(['agent-1']);
    await inBox.close();
  });

  it("leaves running an earlier controller's watcher whose record isn't judged alive", async () => {
    const root = join(dir, 'data', 'watchers', 'agent-1');
    mkdirSync(join(root, 'supervisor'), { recursive: true });
    const detached = await fakeWatcher(root);
    writeFileSync(join(root, 'supervisor', 'owner.json'), JSON.stringify({ pid: detached.pid }));
    const inBox = boxRuntime(fakeBox({ judgeOwnerRecord: async () => ({ kind: 'reused' }) }));
    await inBox.writeCredentials('agent-1', RELAY);
    await inBox.launch('agent-1', template(), LAUNCH);
    expect(detached.exitCode).toBeNull();
    expect(detached.signalCode).toBeNull();
    await inBox.close();
  });

  it('reads a recorded owner as alive only as the box judges it', async () => {
    const root = join(dir, 'data', 'watchers', 'agent-1');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'shared-owner.lock'), JSON.stringify({ pid: process.pid }));
    const layout = dataLayout(join(dir, 'data'));
    expect((await observeOnDisk(layout, 'agent-1', null)).alive).toBe(true);
    const stale = fakeBox({ recordedOwnerAlive: async () => false });
    expect((await observeOnDisk(layout, 'agent-1', stale)).alive).toBe(false);
  });

  it("round-trips the box's gateway record, and reads a file without one exactly as before", async () => {
    const gateway = {
      token: 'swpg_placeholder',
      provider: 'claude',
      kind: 'api-key',
      revision: '3',
    };
    const withGateway = relayCredentialsBody('agent-1', { ...RELAY, gateway });
    expect(parseRelayCredentials(withGateway, 'agent-1')).toEqual({ ...RELAY, gateway });
    const plain = relayCredentialsBody('agent-1', RELAY);
    expect(JSON.parse(plain)).not.toHaveProperty('gateway');
    expect(parseRelayCredentials(plain, 'agent-1')).toEqual(RELAY);
    const forged = JSON.stringify({
      ...JSON.parse(plain),
      gateway: { ...gateway, token: 'not-a-gateway-token' },
    });
    expect(parseRelayCredentials(forged, 'agent-1')).toEqual(RELAY);
  });

  it('answers a provider check the same way, in its own process group', async () => {
    expect(
      await probeProvider(bundle, 'claude', '/usr/bin/claude', '/tmp', process.env, { box: true })
    ).toEqual({
      status: 'authenticated',
      message: '--probe claude /tmp /usr/bin/claude',
      models: [],
    });
  });

  it.skipIf(process.platform === 'win32')(
    'ends the whole process group of a provider check that runs too long',
    async () => {
      const beat = join(dir, 'beat');
      const cli = join(dir, 'busy-cli.cjs');
      const slow = join(dir, 'slow-bundle.cjs');
      writeFileSync(
        cli,
        `setInterval(() => require('node:fs').appendFileSync(${JSON.stringify(beat)}, 'x'), 20);`
      );
      // A check that starts a CLI of its own, which keeps writing, then never answers.
      writeFileSync(
        slow,
        `require('node:child_process').spawn(process.execPath, [${JSON.stringify(cli)}], { stdio: 'ignore' });
         setInterval(() => {}, 1000);`
      );
      await expect(
        probeProvider(slow, 'claude', '/usr/bin/claude', '/tmp', process.env, {
          box: true,
          timeoutMs: 500,
        })
      ).rejects.toThrow('did not finish within 0.5 s');
      await delay(100);
      const size = statSync(beat).size;
      await delay(300);
      expect(statSync(beat).size).toBe(size);
    }
  );
});

describe('clearLeftLoginChecks', () => {
  it('clears a login check left by a controller stopped in the middle of one', async () => {
    const left = join(dir, 'data', 'login-check', 'claude', 'provider-home');
    mkdirSync(left, { recursive: true });
    writeFileSync(join(left, 'google-credentials.json'), '{}');
    writeFileSync(join(dir, 'data', 'kept.txt'), 'kept');
    await clearLeftLoginChecks(join(dir, 'data'));
    expect(existsSync(join(dir, 'data', 'login-check'))).toBe(false);
    expect(existsSync(join(dir, 'data', 'kept.txt'))).toBe(true);
    await clearLeftLoginChecks(join(dir, 'data'));
  });
});

describe('isInside', () => {
  it('is true strictly below the root', () => {
    expect(isInside('/data/workspaces', '/data/workspaces/scout')).toBe(true);
    expect(isInside('/data/workspaces', '/data/workspaces/a/b')).toBe(true);
    expect(isInside('/data/workspaces', '/data/workspaces')).toBe(false);
    expect(isInside('/data/workspaces', '/data/workspaces/../x')).toBe(false);
    expect(isInside('/data/workspaces', '/data/workspaces-other/x')).toBe(false);
    expect(isInside('/data/workspaces', '/data/workspaces/..scout')).toBe(true);
  });
});
