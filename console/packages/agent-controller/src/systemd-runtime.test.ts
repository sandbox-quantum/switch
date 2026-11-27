import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from './log';
import type { SeparateUsersConfig } from './separate-users';
import { ControllerStore } from './store';
import { environmentLine, SystemdRuntime } from './systemd-runtime';
import { buildWatcherTemplate } from './template';

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

/** A `systemctl` that records what it is asked and answers from `units`. */
class FakeSystemctl {
  readonly calls: string[][] = [];
  readonly units = new Map<string, { activeState: string; result: string; mainPid: number }>();

  readonly run = async (args: string[]): Promise<string> => {
    this.calls.push(args);
    const verb = args[0] === '--no-block' ? args[1] : args[0];
    const unit = args[0] === '--no-block' ? args[2]! : args[1]!;
    const state = this.units.get(unit) ?? {
      activeState: 'inactive',
      result: 'success',
      mainPid: 0,
    };
    if (verb === 'show')
      return `ActiveState=${state.activeState}\nResult=${state.result}\nMainPID=${state.mainPid}\n`;
    if (verb === 'start') this.units.set(unit, { ...state, activeState: 'active', mainPid: 4242 });
    if (verb === 'stop') this.units.set(unit, { ...state, activeState: 'inactive', mainPid: 0 });
    if (verb === 'reset-failed') this.units.set(unit, { ...state, activeState: 'inactive' });
    return '';
  };

  verbs(): string[] {
    return this.calls.filter((call) => call[0] !== 'show').map((call) => call.join(' '));
  }
}

let dir: string;
let config: SeparateUsersConfig;
let store: ControllerStore;
let systemctl: FakeSystemctl;
let runtime: SystemdRuntime;
let env: NodeJS.ProcessEnv;

function makeRuntime(): SystemdRuntime {
  return new SystemdRuntime({
    config,
    store,
    systemctl: systemctl.run,
    env,
    log: silentLogger,
    now: () => 1_000,
    codexTemplate: true,
  });
}

function template(
  agentId: string,
  cwd: string,
  binaryPath = '/usr/bin/claude',
  provider = 'claude'
) {
  return buildWatcherTemplate({
    agentId,
    provider,
    definition: {
      name: agentId,
      model: null,
      advanced_config: {},
      instructions: '',
      auto_approve: false,
      auto_mode: false,
    },
    cwd,
    credentialsPath: runtime.credentialsPath(agentId, provider),
    binaryPath,
  });
}

async function start(agentId: string): Promise<string> {
  await runtime.writeCredentials(agentId, RELAY);
  const cwd = await runtime.workingDirectory(agentId, agentId, null);
  await runtime.launch(agentId, template(agentId, cwd), LAUNCH);
  return cwd;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'systemd-runtime-'));
  config = {
    v: 1,
    user: 'controller',
    uid: process.getuid!(),
    gid: process.getgid!(),
    dataDir: join(dir, 'data'),
    agentsDir: join(dir, 'agents'),
    agentUsers: 2,
    node: '/usr/bin/node',
    bundle: '/opt/switch/shared-host.mjs',
    releasesDir: null,
  };
  mkdirSync(config.dataDir, { mode: 0o700 });
  mkdirSync(config.agentsDir, { mode: 0o700 });
  store = ControllerStore.open(join(config.dataDir, 'controller.db'));
  systemctl = new FakeSystemctl();
  env = {
    ANTHROPIC_API_KEY: 'sk-placeholder',
    CLAUDE_CONFIG_DIR: '/home/controller/.claude',
    UNRELATED: 'kept out',
  };
  runtime = makeRuntime();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// Linux only: systemd and Linux users.
describe.skipIf(process.platform === 'win32')('SystemdRuntime', () => {
  it('runs an agent as the first free agent user, from files the unit loads', async () => {
    const cwd = await start('agent-1');
    const root = join(config.agentsDir, '01');
    expect(store.agentUser('agent-1')).toBe(1);
    // As the agent sees it, whichever user it runs as.
    expect(cwd).toBe(join(config.agentsDir, 'agent', 'workspace'));
    expect(systemctl.verbs()).toEqual([`start switch-agent-${config.uid}@01.service`]);
    expect(runtime.credentialsPath('agent-1', 'claude')).toBe(
      `/run/credentials/switch-agent-${config.uid}@01.service/relay`
    );
    expect(await runtime.readCredentials('agent-1')).toEqual(RELAY);
    expect(readFileSync(join(root, '.switch-agent-id'), 'utf8').trim()).toBe('agent-1');
    const saved = JSON.parse(readFileSync(join(root, 'watcher', 'config.json'), 'utf8'));
    expect(saved.session.agentId).toBe('agent-1');
    expect(JSON.parse(readFileSync(join(root, 'watcher', 'watch.json'), 'utf8'))).toEqual({
      enabled: true,
      spawn: true,
    });
    expect(statSync(root).mode & 0o7777).toBe(0o1770);
    expect(statSync(join(root, 'watcher', 'config.json')).mode & 0o777).toBe(0o640);
    // Only provider settings, and none naming a path in the controller's home.
    expect(readFileSync(join(config.dataDir, 'units', '01', 'environment'), 'utf8')).toBe(
      "ANTHROPIC_API_KEY='sk-placeholder'\n"
    );
  });

  it("gives an agent the variables a provider's runtime asks for, but a path in the controller's home", async () => {
    env = {
      ...env,
      COPILOT_GITHUB_TOKEN: 'token-placeholder',
      COPILOT_HOME: '/home/controller/.copilot',
    };
    runtime = makeRuntime();
    await start('agent-1');
    expect(readFileSync(join(config.dataDir, 'units', '01', 'environment'), 'utf8')).toBe(
      "ANTHROPIC_API_KEY='sk-placeholder'\nCOPILOT_GITHUB_TOKEN='token-placeholder'\n"
    );
  });

  it('gives each agent a user of its own, and says so when none is left', async () => {
    await start('agent-1');
    await start('agent-2');
    expect(store.agentUser('agent-2')).toBe(2);
    await expect(runtime.writeCredentials('agent-3', RELAY)).rejects.toMatchObject({
      reason: 'capacity_exceeded',
    });
  });

  it('hands a running agent host its new configuration without restarting it', async () => {
    await start('agent-1');
    const before = JSON.parse(
      readFileSync(join(config.agentsDir, '01', 'watcher', 'config.json'), 'utf8')
    );
    systemctl.calls.length = 0;
    const cwd = await runtime.workingDirectory('agent-1', 'agent-1', null);
    await runtime.launch('agent-1', template('agent-1', cwd), LAUNCH);
    expect(systemctl.verbs()).toEqual([]);
    const after = JSON.parse(
      readFileSync(join(config.agentsDir, '01', 'watcher', 'config.json'), 'utf8')
    );
    // The session identity an earlier run saved is kept.
    expect(after.session.hostId).toBe(before.session.hostId);
  });

  it('restarts through a stop when asked to', async () => {
    await start('agent-1');
    systemctl.calls.length = 0;
    const cwd = await runtime.workingDirectory('agent-1', 'agent-1', null);
    await runtime.launch('agent-1', template('agent-1', cwd), { ...LAUNCH, restart: true });
    const unit = `switch-agent-${config.uid}@01.service`;
    const codex = `switch-agent-${config.uid}-codex@01.service`;
    expect(systemctl.verbs()).toEqual([`stop ${unit}`, `stop ${codex}`, `start ${unit}`]);
  });

  it('starts a failed unit again after clearing its failure', async () => {
    await start('agent-1');
    const unit = `switch-agent-${config.uid}@01.service`;
    systemctl.units.set(unit, { activeState: 'failed', result: 'exit-code', mainPid: 0 });
    expect((await runtime.observe('agent-1')).failure).toContain('failed (exit-code)');
    systemctl.calls.length = 0;
    const cwd = await runtime.workingDirectory('agent-1', 'agent-1', null);
    await runtime.launch('agent-1', template('agent-1', cwd), LAUNCH);
    expect(systemctl.verbs()).toEqual([`reset-failed ${unit}`, `start ${unit}`]);
  });

  it('refuses a working directory outside the agent’s own', async () => {
    await runtime.writeCredentials('agent-1', RELAY);
    await expect(runtime.workingDirectory('agent-1', 'scout', '/srv/repo')).rejects.toMatchObject({
      reason: 'definition_invalid',
    });
    await expect(runtime.workingDirectory('agent-1', 'scout', 'relative')).rejects.toMatchObject({
      reason: 'definition_invalid',
    });
    const inside = join(config.agentsDir, 'agent', 'workspace', 'repo');
    expect(await runtime.workingDirectory('agent-1', 'scout', inside)).toBe(inside);
    // Made for the agent to write in: the agents' group, and its bits.
    const made = statSync(join(config.agentsDir, '01', 'workspace', 'repo'));
    expect(made.gid).toBe(config.gid);
    expect(made.mode & 0o777).toBe(0o770);
  });

  it('refuses a provider CLI agents cannot reach', async () => {
    await runtime.writeCredentials('agent-1', RELAY);
    const cwd = await runtime.workingDirectory('agent-1', 'agent-1', null);
    await expect(
      runtime.launch('agent-1', template('agent-1', cwd, '/home/me/.local/bin/claude'), LAUNCH)
    ).rejects.toMatchObject({ reason: 'provider_not_installed' });
    expect(
      await runtime.probe('claude', '/home/me/.local/bin/claude', config.dataDir, null)
    ).toMatchObject({ status: 'unconfigured' });
  });

  it('observes the agent host’s health, current only for the unit’s process', async () => {
    await start('agent-1');
    const health = join(config.agentsDir, '01', 'watcher', 'health.json');
    const body = {
      state: 'connected',
      detail: null,
      since: '2026-01-01T00:00:00Z',
      placements: {},
      pid: 4242,
      updatedAt: '2026-01-01T00:00:00Z',
    };
    writeFileSync(health, JSON.stringify(body));
    const live = await runtime.observe('agent-1');
    expect(live.alive).toBe(true);
    expect(live.health).toMatchObject({ pid: 4242, current: true });
    writeFileSync(health, JSON.stringify({ ...body, pid: 1 }));
    expect((await runtime.observe('agent-1')).health).toMatchObject({ current: false });
    expect(await runtime.observe('agent-never-started')).toMatchObject({ alive: false });
  });

  it('sets a removed agent’s directory aside, frees its user, and gives it back later', async () => {
    await start('agent-1');
    writeFileSync(join(config.agentsDir, '01', 'workspace', 'notes.md'), 'kept');
    systemctl.calls.length = 0;
    await runtime.deleteCredentials('agent-1');
    const unit = `switch-agent-${config.uid}@01.service`;
    const codex = `switch-agent-${config.uid}-codex@01.service`;
    expect(systemctl.verbs()).toEqual([`stop ${unit}`, `stop ${codex}`]);
    expect(store.agentUser('agent-1')).toBeNull();
    expect(existsSync(join(config.agentsDir, '01'))).toBe(false);
    expect(existsSync(join(config.dataDir, 'units', '01'))).toBe(false);
    expect(
      readFileSync(join(config.agentsDir, 'released', 'agent-1', 'workspace', 'notes.md'), 'utf8')
    ).toBe('kept');

    // Another agent takes the freed user, in a fresh directory.
    await start('agent-2');
    expect(store.agentUser('agent-2')).toBe(1);
    expect(existsSync(join(config.agentsDir, '01', 'workspace', 'notes.md'))).toBe(false);
    // The first comes back on the next free user, with its directory.
    await start('agent-1');
    expect(store.agentUser('agent-1')).toBe(2);
    expect(readFileSync(join(config.agentsDir, '02', 'workspace', 'notes.md'), 'utf8')).toBe(
      'kept'
    );
  });

  it('sets aside a directory its user held for another agent', async () => {
    const stale = join(config.agentsDir, '01');
    mkdirSync(join(stale, 'workspace'), { recursive: true });
    writeFileSync(join(stale, '.switch-agent-id'), 'agent-old\n');
    await start('agent-1');
    expect(existsSync(join(config.agentsDir, 'released', 'agent-old', 'workspace'))).toBe(true);
    expect(readFileSync(join(stale, '.switch-agent-id'), 'utf8').trim()).toBe('agent-1');
  });

  it('sets aside a directory whose marker names a path as an unknown agent’s, inside released/', async () => {
    const stale = join(config.agentsDir, '01');
    mkdirSync(join(stale, 'workspace'), { recursive: true });
    writeFileSync(join(stale, '.switch-agent-id'), '../../escaped\n');
    await start('agent-1');
    expect(existsSync(join(config.agentsDir, 'released', 'unknown-1000', 'workspace'))).toBe(true);
    expect(existsSync(join(dir, 'escaped'))).toBe(false);
  });

  it('refuses an agent id that could name a path', async () => {
    for (const agentId of ['../x', 'a/b', '..', '.hidden'])
      await expect(runtime.workingDirectory(agentId, 'x', null)).rejects.toThrow(
        'cannot be used in a file name'
      );
    expect(store.agentUser('../x')).toBeNull();
  });

  it('stops through the watch flags and the unit', async () => {
    await start('agent-1');
    systemctl.calls.length = 0;
    await runtime.stop('agent-1', { wait: false });
    const unit = `switch-agent-${config.uid}@01.service`;
    const codex = `switch-agent-${config.uid}-codex@01.service`;
    expect(systemctl.verbs()).toEqual([`--no-block stop ${unit}`, `--no-block stop ${codex}`]);
    expect(
      JSON.parse(readFileSync(join(config.agentsDir, '01', 'watcher', 'watch.json'), 'utf8'))
    ).toEqual({ enabled: false, spawn: false });
    systemctl.calls.length = 0;
    await runtime.stop('agent-unknown', { wait: true });
    expect(systemctl.verbs()).toEqual([]);
  });

  it('runs a Codex agent as the template its sandbox can run in', async () => {
    await start('agent-1');
    const unit = `switch-agent-${config.uid}@01.service`;
    const codex = `switch-agent-${config.uid}-codex@01.service`;
    expect(runtime.credentialsPath('agent-1', 'codex')).toBe(`/run/credentials/${codex}/relay`);
    systemctl.calls.length = 0;
    const cwd = await runtime.workingDirectory('agent-1', 'agent-1', null);
    // Its provider changed: a new identity, and the other template's unit stopped.
    await runtime.launch('agent-1', template('agent-1', cwd, '/usr/bin/codex', 'codex'), {
      ...LAUNCH,
      replaceIdentity: true,
    });
    expect(systemctl.verbs()).toEqual([`stop ${unit}`, `stop ${codex}`, `start ${codex}`]);
    expect((await runtime.observe('agent-1')).alive).toBe(true);
  });

  it('stops a Codex agent an older controller ran as the other template before starting it', async () => {
    const older = new SystemdRuntime({
      config,
      store,
      systemctl: systemctl.run,
      env,
      log: silentLogger,
      now: () => 1_000,
      codexTemplate: false,
    });
    const current = runtime;
    runtime = older;
    await older.writeCredentials('agent-1', RELAY);
    const cwd = await older.workingDirectory('agent-1', 'agent-1', null);
    await older.launch('agent-1', template('agent-1', cwd, '/usr/bin/codex', 'codex'), LAUNCH);
    runtime = current;
    const unit = `switch-agent-${config.uid}@01.service`;
    const codex = `switch-agent-${config.uid}-codex@01.service`;
    expect(systemctl.units.get(unit)?.activeState).toBe('active');
    systemctl.calls.length = 0;
    await runtime.launch('agent-1', template('agent-1', cwd, '/usr/bin/codex', 'codex'), LAUNCH);
    expect(systemctl.verbs()).toEqual([`stop ${unit}`, `start ${codex}`]);
  });

  it('runs a Codex agent as the one template where the setup has no other', async () => {
    runtime = new SystemdRuntime({
      config,
      store,
      systemctl: systemctl.run,
      env,
      log: silentLogger,
      now: () => 1_000,
      codexTemplate: false,
    });
    const unit = `switch-agent-${config.uid}@01.service`;
    expect(runtime.credentialsPath('agent-1', 'codex')).toBe(`/run/credentials/${unit}/relay`);
    await runtime.writeCredentials('agent-1', RELAY);
    const cwd = await runtime.workingDirectory('agent-1', 'agent-1', null);
    await runtime.launch('agent-1', template('agent-1', cwd, '/usr/bin/codex', 'codex'), LAUNCH);
    expect(systemctl.verbs()).toEqual([`start ${unit}`]);
  });

  it('removes a given login’s files and token when the agent is removed, keeping its work', async () => {
    await start('agent-1');
    const watcher = join(config.agentsDir, '01', 'watcher');
    // As the agent host writes them (`materializeHostedProvider`).
    const files = [
      'provider-home/auth.json',
      'provider-home/auth.json.switch-credential',
      'provider-data/opencode/auth.json',
      'provider-home/google-credentials.json',
    ];
    for (const file of files) {
      mkdirSync(dirname(join(watcher, file)), { recursive: true });
      writeFileSync(join(watcher, file), 'login-placeholder');
    }
    const configPath = join(watcher, 'config.json');
    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    saved.start.input.env = {
      ...saved.start.input.env,
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-given',
      KEPT: 'yes',
    };
    writeFileSync(configPath, JSON.stringify(saved));
    writeFileSync(join(config.agentsDir, '01', 'workspace', 'notes.md'), 'kept');

    await runtime.deleteCredentials('agent-1');
    const released = join(config.agentsDir, 'released', 'agent-1');
    for (const file of files) expect(existsSync(join(released, 'watcher', file))).toBe(false);
    const env = JSON.parse(readFileSync(join(released, 'watcher', 'config.json'), 'utf8')).start
      .input.env;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.KEPT).toBe('yes');
    expect(readFileSync(join(released, 'workspace', 'notes.md'), 'utf8')).toBe('kept');
  });

  it('removes a withdrawn login’s files from a stopped agent’s directory', async () => {
    await start('agent-1');
    await runtime.stop('agent-1', { wait: true });
    const auth = join(config.agentsDir, '01', 'watcher', 'provider-home', 'auth.json');
    mkdirSync(dirname(auth), { recursive: true });
    writeFileSync(auth, 'login-placeholder');
    await runtime.forgetProviderLogin('agent-1');
    expect(existsSync(auth)).toBe(false);
    // An agent with no user here has nothing to remove.
    await runtime.forgetProviderLogin('agent-unknown');
  });

  it('logs a login it could not remove as an error, and still removes the agent', async () => {
    await start('agent-1');
    const home = join(config.agentsDir, '01', 'watcher', 'provider-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'auth.json'), 'login-placeholder');
    // A directory an older agent host made private to the agent's user.
    chmodSync(home, 0o500);
    const errors: string[] = [];
    runtime = new SystemdRuntime({
      config,
      store,
      systemctl: systemctl.run,
      env,
      log: { ...silentLogger, error: (message) => void errors.push(message) },
      now: () => 1_000,
      codexTemplate: true,
    });
    try {
      await runtime.deleteCredentials('agent-1');
    } finally {
      chmodSync(join(config.agentsDir, 'released', 'agent-1', 'watcher', 'provider-home'), 0o700);
    }
    expect(errors).toEqual(['Could not remove the provider login of an agent no longer here']);
    expect(store.agentUser('agent-1')).toBeNull();
  });
});

// Linux only: systemd and Linux users.
describe.skipIf(process.platform === 'win32')('environmentLine', () => {
  it('quotes a value so systemd reads it back as is', () => {
    expect(environmentLine('KEY', 'a b$c"d')).toBe(`KEY='a b$c"d'`);
    expect(environmentLine('KEY', `it's $x "y" \\z`)).toBe(`KEY="it's \\$x \\"y\\" \\\\z"`);
  });
});
