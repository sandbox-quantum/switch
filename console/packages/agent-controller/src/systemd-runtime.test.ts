import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderReadiness } from '@switch-console/agent-providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoginRevision } from './ec2/sealed-logins';
import { ReasonedError } from './errors';
import { silentLogger } from './log';
import { type Ec2Layout, ec2Layout } from './paths';
import type { LaunchOptions } from './runtime';
import type { Provider } from './schemas';
import { type Systemctl, SystemdRuntime, type UnitLogins } from './systemd-runtime';
import { buildWatcherTemplate } from './template';

class FakeLogins implements UnitLogins {
  readonly materialized: string[] = [];
  readonly removed: string[] = [];
  private listener: ((change: LoginRevision) => void) | null = null;
  async materialize(agentId: string, provider: Provider) {
    this.materialized.push(`${agentId}:${provider}`);
  }
  async remove(agentId: string) {
    this.removed.push(agentId);
  }
  async removeNative(agentId: string, provider: Provider) {
    this.removed.push(`${agentId}:${provider}`);
  }
  async readiness(): Promise<ProviderReadiness> {
    return { status: 'authenticated', message: '', models: [] };
  }
  onRevision(listener: (change: LoginRevision) => void) {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
  emit(change: LoginRevision) {
    this.listener?.(change);
  }
}

/** systemctl as a map of unit states, recording every argv it is given. */
class FakeSystemctl {
  readonly calls: string[][] = [];
  readonly states = new Map<string, Record<string, string>>();
  readonly run: Systemctl = async (args) => {
    this.calls.push(args);
    const verb = args[0] === '--no-block' ? args[1]! : args[0]!;
    const unit = args[args[0] === '--no-block' ? 2 : 1]!;
    const state = this.states.get(unit) ?? {
      ActiveState: 'inactive',
      Result: 'success',
      NRestarts: '0',
      InvocationID: '',
    };
    if (verb === 'show')
      return `${Object.entries(state)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`;
    if (verb === 'start' || verb === 'restart')
      this.states.set(unit, { ...state, ActiveState: 'active', InvocationID: 'inv-4242' });
    if (verb === 'stop')
      this.states.set(unit, { ...state, ActiveState: 'inactive', InvocationID: '' });
    if (verb === 'reset-failed') this.states.set(unit, { ...state, ActiveState: 'inactive' });
    return '';
  };
  verbs(): string[] {
    return this.calls.filter((args) => !args.includes('show')).map((args) => args.join(' '));
  }
}

let dir: string;
let layout: Ec2Layout;
let clock: number;
let systemctl: FakeSystemctl;
let logins: FakeLogins;
let runtime: SystemdRuntime;
/** What the repository lookup answers, or throws; and who it was asked for. */
let repositoryAnswer: () => string;
let repositoryLookups: string[];

beforeEach(() => {
  repositoryAnswer = () => 'Example-Org/Example.Repo';
  repositoryLookups = [];
  dir = mkdtempSync(join(tmpdir(), 'controller-systemd-'));
  layout = ec2Layout({ dataRoot: join(dir, 'data'), runRoot: join(dir, 'run') });
  clock = Date.parse('2026-01-01T12:00:00Z');
  systemctl = new FakeSystemctl();
  logins = new FakeLogins();
  runtime = new SystemdRuntime({
    layout,
    systemctl: systemctl.run,
    logins,
    agentGroupId: process.getgid!(),
    log: silentLogger,
    now: () => clock,
    idleCheckMs: 60_000,
    forceRestartAfterMs: 30 * 60_000,
    repositoryName: async (agentId) => {
      repositoryLookups.push(agentId);
      return repositoryAnswer();
    },
  });
});

afterEach(async () => {
  await runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

const START: LaunchOptions = {
  isolation: 'isolated',
  restart: false,
  replaceIdentity: false,
  clearTakenOver: false,
  skills: [],
  repository: null,
};

function template(agentId = 'agent-1', cwd = join(dir, 'data', 'worktrees', agentId, 'scout')) {
  return buildWatcherTemplate({
    agentId,
    provider: 'claude',
    definition: {
      name: 'scout',
      model: null,
      advanced_config: {},
      instructions: '',
      auto_approve: false,
    },
    cwd,
    credentialsPath: layout.unitCredentialsPath(agentId),
    binaryPath: '/opt/switch/providers/claude',
  });
}

const UNIT = 'switch-agent@agent-1.service';
const REPOSITORY = { installation_id: 123, repository_id: 456 };

describe('SystemdRuntime', () => {
  it('names the unit credentials, and refuses an id a unit cannot carry', () => {
    expect(runtime.credentialsPath('agent-1')).toBe(
      '/run/credentials/switch-agent@agent-1.service/agent'
    );
    for (const bad of ['../x', 'a/b', 'a.b', '', 'x'.repeat(65), 'a@b'])
      expect(() => runtime.credentialsPath(bad)).toThrow(/not a valid unit instance/);
  });

  it('writes what the unit runs from, shared with the agents group, and starts it', async () => {
    await runtime.launch('agent-1', template(), START);
    expect(systemctl.verbs()).toEqual([`start ${UNIT}`]);
    expect(logins.materialized).toEqual(['agent-1:claude']);
    const root = layout.agentRoot('agent-1');
    const watcher = layout.watcherRoot('agent-1');
    for (const path of [root, watcher, layout.worktreeRoot('agent-1')])
      expect(statSync(path).mode & 0o7777).toBe(0o3770);
    for (const name of ['config.json', 'template.json', 'watch.json'])
      expect(statSync(join(watcher, name)).mode & 0o777).toBe(0o640);
    const config = JSON.parse(readFileSync(join(watcher, 'config.json'), 'utf8'));
    expect(config.execution.credentialsPath).toBe(layout.unitCredentialsPath('agent-1'));
    expect(config.start.input.env).toMatchObject({
      HOME: join(root, 'home'),
      CLAUDE_CONFIG_DIR: join(root, 'provider-home', 'claude'),
      TMPDIR: join(root, 'tmp'),
    });
    expect(JSON.parse(readFileSync(join(watcher, 'watch.json'), 'utf8'))).toEqual({
      enabled: true,
      spawn: true,
    });
    expect(JSON.parse(readFileSync(join(root, 'workspace.json'), 'utf8'))).toEqual({
      repository: null,
      mirrorPath: null,
      workspacePath: join(layout.worktreeRoot('agent-1'), 'scout'),
      skills: [],
      instructions: '',
    });
    expect(systemctl.calls.every((args) => !args.join(' ').includes(';'))).toBe(true);
  });

  it('writes the agent’s skills for its unit to install', async () => {
    const skills = [{ slug: 'github', files: { 'SKILL.md': '# GitHub' } }];
    await runtime.launch('agent-1', template(), { ...START, skills });
    const workspace = JSON.parse(
      readFileSync(join(layout.agentRoot('agent-1'), 'workspace.json'), 'utf8')
    );
    expect(workspace.skills).toEqual(skills);
  });

  it('names the repository and the agent’s own mirror for the unit to make the workspace a worktree of', async () => {
    const cwd = join(layout.worktreeRoot('agent-1'), 'example-org', 'example.repo');
    await runtime.launch('agent-1', template('agent-1', cwd), { ...START, repository: REPOSITORY });
    expect(repositoryLookups).toEqual(['agent-1']);
    const workspace = JSON.parse(
      readFileSync(join(layout.agentRoot('agent-1'), 'workspace.json'), 'utf8')
    );
    expect(workspace).toMatchObject({
      repository: 'Example-Org/Example.Repo',
      mirrorPath: join(layout.agentRoot('agent-1'), 'repos', 'example-org', 'example.repo.git'),
      workspacePath: cwd,
    });
    const config = JSON.parse(
      readFileSync(join(layout.watcherRoot('agent-1'), 'config.json'), 'utf8')
    );
    expect(config.start.input.cwd).toBe(cwd);
    expect(systemctl.verbs()).toEqual([`start ${UNIT}`]);
  });

  it('does not start an agent whose repository it cannot name', async () => {
    repositoryAnswer = () => {
      throw new Error('The owner must reconnect GitHub.');
    };
    await expect(
      runtime.launch('agent-1', template(), { ...START, repository: REPOSITORY })
    ).rejects.toMatchObject({
      reason: 'repo_clone_failed',
      message: expect.stringContaining('reconnect GitHub'),
    });
    expect(systemctl.verbs()).toEqual([]);
  });

  it('refuses a repository agent whose directory is not under its worktrees', async () => {
    await expect(
      runtime.launch('agent-1', template('agent-1', join(layout.agentRoot('agent-1'), 'work')), {
        ...START,
        repository: REPOSITORY,
      })
    ).rejects.toMatchObject({ reason: 'definition_invalid' });
    expect(repositoryLookups).toEqual([]);
  });

  it('refuses a working directory outside the agent’s own, and a linked agent root', async () => {
    await expect(
      runtime.launch(
        'agent-1',
        template('agent-1', join(dir, 'data', 'worktrees', 'agent-2')),
        START
      )
    ).rejects.toBeInstanceOf(ReasonedError);
    mkdirSync(layout.agentsRoot, { recursive: true });
    mkdirSync(join(dir, 'elsewhere'));
    symlinkSync(join(dir, 'elsewhere'), layout.agentRoot('agent-3'));
    await expect(runtime.launch('agent-3', template('agent-3'), START)).rejects.toThrow(
      /never followed/
    );
    expect(systemctl.verbs()).toEqual([]);
  });

  it('never writes through a link the agent planted in its root', async () => {
    await runtime.launch('agent-1', template(), START);
    const target = join(dir, 'target');
    writeFileSync(target, 'untouched');
    const config = join(layout.watcherRoot('agent-1'), 'config.json');
    rmSync(config);
    symlinkSync(target, config);
    await runtime.launch('agent-1', template(), { ...START, restart: true });
    expect(readFileSync(target, 'utf8')).toBe('untouched');
    expect(statSync(config).isFile()).toBe(true);
  });

  it('never reads a failure through a supervisor directory the agent linked elsewhere', async () => {
    await runtime.launch('agent-1', template(), START);
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'failure.json'), JSON.stringify({ message: 'planted' }));
    const supervisor = join(layout.watcherRoot('agent-1'), 'supervisor');
    rmSync(supervisor, { recursive: true, force: true });
    symlinkSync(elsewhere, supervisor);
    await expect(runtime.observe('agent-1')).rejects.toThrow(/symbolic link; it is not followed/);
    rmSync(supervisor);
    mkdirSync(supervisor);
    writeFileSync(join(supervisor, 'failure.json'), JSON.stringify({ message: 'real' }));
    expect((await runtime.observe('agent-1')).failure).toBe('real');
  });

  it('observes the unit and the agent host’s health', async () => {
    expect(await runtime.observe('agent-1')).toMatchObject({ alive: false, health: null });
    await runtime.launch('agent-1', template(), START);
    writeFileSync(
      join(layout.watcherRoot('agent-1'), 'health.json'),
      JSON.stringify({
        state: 'connected',
        detail: null,
        since: '2026-01-01T12:00:00Z',
        placements: { 'session-a': '!room:example.org' },
        pid: 1,
        invocation: 'inv-4242',
        updatedAt: '2026-01-01T12:00:01Z',
        busy: false,
        lastActivityAt: '2026-01-01T11:00:00Z',
      })
    );
    const running = await runtime.observe('agent-1');
    expect(running).toMatchObject({
      alive: true,
      configured: { provider: 'claude' },
      flags: { enabled: true, spawn: true },
      health: { state: 'connected', current: true },
      activity: { busy: false, lastActivityAt: '2026-01-01T11:00:00Z' },
      unit: { restarts10m: 0, oomKills: 0 },
    });
    expect(systemctl.calls.find((args) => args[0] === 'show')).toEqual([
      'show',
      UNIT,
      '--property=ActiveState,SubState,Result,NRestarts,InvocationID,ActiveEnterTimestampMonotonic',
    ]);

    systemctl.states.set(UNIT, {
      ActiveState: 'active',
      Result: 'oom-kill',
      NRestarts: '2',
      InvocationID: 'inv-5000',
    });
    const restarted = await runtime.observe('agent-1');
    expect(restarted.health?.current).toBe(false);
    expect(restarted.activity).toBeNull();
    expect(restarted.unit).toEqual({ restarts10m: 2, oomKills: 1 });
    clock += 10 * 60_000;
    expect((await runtime.observe('agent-1')).unit).toEqual({ restarts10m: 0, oomKills: 1 });

    systemctl.states.set(UNIT, {
      ActiveState: 'failed',
      Result: 'exit-code',
      NRestarts: '2',
      InvocationID: '',
    });
    expect(await runtime.observe('agent-1')).toMatchObject({
      alive: false,
      failure: 'The agent unit failed (exit-code).',
    });
  });

  it('stops the unit, turning its watcher off first, and forgets it', async () => {
    await runtime.launch('agent-1', template(), START);
    await runtime.stop('agent-1', { wait: false });
    expect(
      JSON.parse(readFileSync(join(layout.watcherRoot('agent-1'), 'watch.json'), 'utf8'))
    ).toEqual({ enabled: false, spawn: false });
    systemctl.states.set(UNIT, {
      ActiveState: 'failed',
      Result: 'exit-code',
      NRestarts: '0',
      InvocationID: '',
    });
    await runtime.writeCredentials('agent-1', {
      endpoint: 'http://127.0.0.1:47100',
      token: 'swlr_test',
    });
    expect(statSync(layout.credentialsFile('agent-1')).mode & 0o777).toBe(0o600);
    expect(await runtime.readCredentials('agent-1')).toEqual({
      endpoint: 'http://127.0.0.1:47100',
      token: 'swlr_test',
    });
    await runtime.deleteCredentials('agent-1');
    expect(systemctl.verbs()).toEqual([
      `start ${UNIT}`,
      `--no-block stop ${UNIT}`,
      `reset-failed ${UNIT}`,
    ]);
    expect(logins.removed).toEqual(['agent-1']);
    expect(await runtime.readCredentials('agent-1')).toBeNull();
    expect(statSync(layout.agentRoot('agent-1')).isDirectory()).toBe(true);
  });

  it('places working directories under the agents’ own folders only', async () => {
    await expect(runtime.workingDirectory('scout', null)).rejects.toMatchObject({
      reason: 'definition_invalid',
    });
    await expect(runtime.workingDirectory('scout', '/etc')).rejects.toMatchObject({
      reason: 'definition_invalid',
    });
    const inside = join(layout.worktreesRoot, 'agent-1', 'repo');
    expect(await runtime.workingDirectory('scout', inside)).toBe(inside);
  });

  it('restarts an agent for a new login once it is idle, or after the grace period', async () => {
    await runtime.launch('agent-1', template('agent-1'), START);
    await runtime.launch('agent-2', template('agent-2'), START);
    const health = (invocation: string, busy: boolean) =>
      JSON.stringify({
        state: 'connected',
        detail: null,
        since: 'x',
        placements: {},
        pid: 1,
        invocation,
        updatedAt: 'x',
        busy,
      });
    writeFileSync(join(layout.watcherRoot('agent-1'), 'health.json'), health('inv-4242', true));
    writeFileSync(join(layout.watcherRoot('agent-2'), 'health.json'), health('inv-4242', false));
    logins.emit({ provider: 'claude', agentIds: ['agent-1', 'agent-2'], connected: true });
    const act = (runtime as unknown as { actOnPending: () => Promise<void> }).actOnPending.bind(
      runtime
    );
    await act();
    expect(systemctl.verbs().slice(2)).toEqual(['restart switch-agent@agent-2.service']);
    await act();
    expect(systemctl.verbs().slice(2)).toEqual(['restart switch-agent@agent-2.service']);
    clock += 30 * 60_000;
    await act();
    expect(systemctl.verbs().slice(2)).toEqual([
      'restart switch-agent@agent-2.service',
      'restart switch-agent@agent-1.service',
    ]);
    logins.emit({ provider: 'claude', agentIds: ['agent-2'], connected: false });
    writeFileSync(join(layout.watcherRoot('agent-2'), 'health.json'), health('inv-4242', false));
    expect(logins.removed).toEqual([]);
    await act();
    expect(systemctl.verbs().at(-1)).toBe('stop switch-agent@agent-2.service');
    expect(logins.removed).toEqual(['agent-2:claude']);
  });
});
