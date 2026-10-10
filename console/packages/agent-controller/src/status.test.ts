import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSealingKeyPair, sealProviderLogin } from '@switch-console/agent-providers';
import { vertexCredentialFixture } from '@switch-console/agent-providers/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from './log';
import { type AgentObservation, emptyObservation } from './runtime';
import { type AgentAssignment, type SealedLoginResponse, statusReportSchema } from './schemas';
import { SealedLogins } from './sealed-logins';
import {
  mapAgentProcess,
  PathProviderLocator,
  PROVIDER_TTL_MS,
  providerStatusFrom,
  ProviderStatuses,
  StatusCollector,
  statusFingerprint,
} from './status';
import { type AgentRow, ControllerStore } from './store';
import { FakeLocator, FakeRuntime } from './testing/fake-runtime';

const NOW = Date.parse('2026-01-01T12:00:00Z');

function entry(overrides: Partial<AgentAssignment> = {}): AgentAssignment {
  return {
    agent_id: 'agent-1',
    revision: 2,
    desired_state: 'running',
    definition: {
      name: 'scout',
      display_name: null,
      icon_url: null,
      provider: 'claude',
      model: null,
      advanced_config: {},
      instructions: '',
      auto_approve: false,
      directory: null,
      isolation: 'shared',
    },
    ...overrides,
  };
}

function row(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    agentId: 'agent-1',
    appliedRevision: 2,
    changedAt: '2026-01-01T11:00:00Z',
    failure: null,
    ...overrides,
  };
}

function health(state: string, detail: string | null = null, current = true) {
  return {
    state,
    detail,
    since: '2026-01-01T11:30:00Z',
    placements: { 'session-b': 'room-1', 'session-a': 'room-2' },
    pid: 99,
    updatedAt: '2026-01-01T11:30:00Z',
    current,
  } as AgentObservation['health'];
}

function observed(overrides: Partial<AgentObservation>): AgentObservation {
  return { ...emptyObservation(), ...overrides };
}

function map(
  observation: AgentObservation,
  rowValue: AgentRow | null = row(),
  assigned = entry(),
  relayAttached = true
) {
  return mapAgentProcess({
    assignment: assigned,
    row: rowValue,
    observation,
    relayAttached,
    nowMs: NOW,
  });
}

describe('mapAgentProcess', () => {
  it('reports attached only while the agent’s events flow through the relay to its watcher', () => {
    const live = observed({ alive: true, health: health('connected') });
    expect(map(live, row(), entry(), false)).toMatchObject({ process: 'running', attached: false });
    expect(map(live, row(), entry(), true)).toMatchObject({ process: 'running', attached: true });
  });

  it('maps a live watcher’s health to the contract’s process states', () => {
    expect(map(observed({ alive: true, health: health('connected') }))).toEqual({
      process: 'running',
      attached: true,
      since: '2026-01-01T11:30:00Z',
    });
    expect(map(observed({ alive: true, health: health('connecting') }))).toMatchObject({
      process: 'starting',
      attached: false,
    });
    expect(
      map(observed({ alive: true, health: health('disconnected', 'HTTP 502') }))
    ).toMatchObject({
      process: 'running',
      attached: false,
      detail: "Reconnecting to the controller's relay: HTTP 502",
    });
    expect(map(observed({ alive: true, health: health('disabled') }))).toMatchObject({
      process: 'stopping',
    });
    expect(map(observed({ alive: true, health: health('taken-over') }))).toMatchObject({
      process: 'stopping',
    });
  });

  it('reads a health file left by a dead process as nothing', () => {
    expect(map(observed({ alive: true, health: health('connected', null, false) }))).toMatchObject({
      process: 'starting',
    });
  });

  it('reports a live watcher being turned off as stopping', () => {
    expect(
      map(
        observed({
          alive: true,
          health: health('connected'),
          flags: { enabled: false, spawn: false },
        })
      ).process
    ).toBe('stopping');
    expect(
      map(
        observed({ alive: true, health: health('connected') }),
        row(),
        entry({ desired_state: 'stopped' })
      ).process
    ).toBe('stopping');
  });

  it('reports a stopped watcher as stopped', () => {
    expect(
      map(
        observed({ health: health('disabled', null, false) }),
        row(),
        entry({ desired_state: 'stopped' })
      )
    ).toEqual({ process: 'stopped', attached: false });
  });

  it('reports an agent never applied as pending', () => {
    expect(map(observed({}), null).process).toBe('pending');
    expect(map(observed({}), row({ appliedRevision: 1 })).process).toBe('pending');
  });

  it('reports a recorded failure with its reason and detail', () => {
    expect(map(observed({ failure: 'Shared SDK host exited with code 1.' }))).toMatchObject({
      process: 'failed',
      reason: 'internal',
      detail: 'Shared SDK host exited with code 1.',
    });
    expect(
      map(observed({ failure: 'Switch rejected the agent credentials (HTTP 401)' }))
    ).toMatchObject({ process: 'failed', reason: 'invalid_credential' });
    expect(
      map(
        observed({}),
        row({ failure: { revision: 2, reason: 'provider_not_installed', detail: 'no' } })
      )
    ).toMatchObject({ process: 'failed', reason: 'provider_not_installed' });
    expect(
      map(observed({ takenOver: { at: 'x', reason: 'Console on laptop', connectionId: 'c' } }))
    ).toMatchObject({ process: 'failed', reason: 'taken_over' });
  });

  it('gives a fresh launch time to come up before calling it crashed', () => {
    expect(map(observed({}), row({ changedAt: new Date(NOW - 5_000).toISOString() })).process).toBe(
      'starting'
    );
    expect(map(observed({}))).toMatchObject({ process: 'crashed', reason: 'internal' });
  });
});

describe('providerStatusFrom', () => {
  const at = '2026-01-01T00:00:00Z';
  const located = { path: '/usr/bin/claude', version: '2.0.0' };
  const readiness = (status: 'authenticated' | 'unauthenticated' | 'unconfigured' | 'unknown') => ({
    status,
    message: '',
    models: [],
  });

  it('maps a missing CLI and each readiness answer', () => {
    expect(providerStatusFrom('claude', null, null, at)).toMatchObject({
      installed: false,
      auth: 'unknown',
      reason: 'provider_not_installed',
    });
    expect(providerStatusFrom('claude', located, readiness('authenticated'), at)).toEqual({
      provider: 'claude',
      installed: true,
      version: '2.0.0',
      auth: 'ok',
      auth_source: 'local',
      checked_at: at,
    });
    expect(providerStatusFrom('claude', located, readiness('unauthenticated'), at)).toMatchObject({
      auth: 'missing',
      reason: 'provider_login_missing',
    });
    expect(providerStatusFrom('claude', located, readiness('unconfigured'), at)).toMatchObject({
      auth: 'missing',
    });
    expect(providerStatusFrom('claude', located, readiness('unknown'), at)).toMatchObject({
      auth: 'unknown',
      auth_source: null,
    });
    expect(providerStatusFrom('claude', located, null, at)).toMatchObject({
      auth: 'unknown',
      reason: 'internal',
    });
  });
});

describe('ProviderStatuses', () => {
  it('checks each provider at most once per TTL, and reports changes', async () => {
    let clock = NOW;
    let changes = 0;
    const runtime = new FakeRuntime();
    const locator = new FakeLocator();
    locator.missing.add('cursor');
    const statuses = new ProviderStatuses({
      locator,
      runtime,
      sealed: null,
      probeCwd: '/tmp',
      now: () => clock,
      log: silentLogger,
      onChange: () => changes++,
    });
    expect(statuses.snapshot()).toEqual([]);
    await statuses.refreshStale();
    expect(runtime.probes).toBe(4);
    expect(changes).toBe(5);
    expect(statuses.snapshot().find((s) => s.provider === 'cursor')?.installed).toBe(false);
    clock += PROVIDER_TTL_MS - 1;
    await statuses.refreshStale();
    expect(runtime.probes).toBe(4);
    clock += 1;
    await statuses.refreshStale();
    expect(runtime.probes).toBe(8);
    expect(changes).toBe(5);
    runtime.readiness = { status: 'unauthenticated', message: '', models: [] };
    await statuses.check('claude');
    expect(changes).toBe(6);
    expect(statuses.snapshot().find((s) => s.provider === 'claude')?.auth).toBe('missing');
  });
});

describe('ProviderStatuses with logins given to the machine', () => {
  const keys = generateSealingKeyPair();
  let answer: SealedLoginResponse | null;
  let reachable: boolean;

  function sealedAnswer(
    credential: string,
    revision = 1,
    kind: 'setup-token' | 'vertex' = 'setup-token',
    provider: 'claude' | 'codex' = 'claude'
  ): SealedLoginResponse {
    return {
      provider,
      revision,
      sealed: sealProviderLogin({
        publicKey: keys.publicKey,
        controllerId: 'controller-1',
        provider,
        login: { kind, credential },
      }),
    };
  }

  function build(runtime: FakeRuntime) {
    return new ProviderStatuses({
      locator: new FakeLocator(),
      runtime,
      sealed: new SealedLogins({
        client: {
          sealedLogin: async () => {
            if (!reachable) throw new Error('Switch is unreachable');
            return answer;
          },
        },
        keys,
        controllerId: 'controller-1',
      }),
      probeCwd: '/tmp',
      now: () => NOW,
      log: silentLogger,
      onChange: () => {},
    });
  }

  beforeEach(() => {
    answer = null;
    reachable = true;
  });

  it('uses the machine’s own login first, and never asks Switch then', async () => {
    const runtime = new FakeRuntime();
    answer = sealedAnswer('sk-ant-oat-given');
    const statuses = build(runtime);
    expect(await statuses.check('claude')).toMatchObject({ auth: 'ok', auth_source: 'local' });
    expect(await statuses.givenLogin('claude')).toBeNull();
    expect(runtime.loginProbes).toEqual([]);
  });

  it('uses a given login once the provider signs in with it', async () => {
    const runtime = new FakeRuntime();
    runtime.readiness = { status: 'unauthenticated', message: 'Not signed in.', models: [] };
    answer = sealedAnswer('sk-ant-oat-given', 3);
    const statuses = build(runtime);
    expect(await statuses.check('claude')).toMatchObject({ auth: 'ok', auth_source: 'sealed' });
    expect(await statuses.givenLogin('claude')).toEqual({
      status: 'connected',
      provider: 'claude',
      revision: '3',
      kind: 'setup-token',
      credential: 'sk-ant-oat-given',
    });
    expect(runtime.loginProbes.map((login) => login.credential)).toEqual(['sk-ant-oat-given']);
  });

  it('uses a given Vertex AI login once Claude signs in with it', async () => {
    const runtime = new FakeRuntime();
    runtime.readiness = { status: 'unauthenticated', message: 'Not signed in.', models: [] };
    answer = sealedAnswer(vertexCredentialFixture(), 4, 'vertex');
    const statuses = build(runtime);
    expect(await statuses.check('claude')).toMatchObject({ auth: 'ok', auth_source: 'sealed' });
    expect(await statuses.givenLogin('claude')).toEqual({
      status: 'connected',
      provider: 'claude',
      revision: '4',
      kind: 'vertex',
      credential: vertexCredentialFixture(),
    });
    expect(runtime.loginProbes.map((login) => login.kind)).toEqual(['vertex']);
  });

  it('refuses a Vertex AI login given for another provider than Claude', async () => {
    const runtime = new FakeRuntime();
    runtime.readiness = { status: 'unauthenticated', message: '', models: [] };
    answer = sealedAnswer(vertexCredentialFixture(), 1, 'vertex', 'codex');
    const statuses = build(runtime);
    expect(await statuses.check('codex')).toMatchObject({ auth: 'missing' });
    expect(statuses.loginProblem('codex')).toEqual({
      code: 'internal',
      message: expect.stringContaining('Only Claude signs in through Vertex AI.'),
    });
    expect(runtime.loginProbes).toEqual([]);
  });

  it('says why a given login is not used', async () => {
    const runtime = new FakeRuntime();
    runtime.readiness = { status: 'unauthenticated', message: '', models: [] };
    const statuses = build(runtime);
    expect(await statuses.check('claude')).toMatchObject({
      auth: 'missing',
      reason: 'provider_login_missing',
    });
    expect(statuses.loginProblem('claude')?.code).toBe('provider_login_missing');

    answer = sealedAnswer('sk-ant-oat-expired');
    runtime.loginReadiness = { status: 'unauthenticated', message: 'Token expired.', models: [] };
    expect(await statuses.check('claude')).toMatchObject({
      auth: 'expired',
      auth_source: 'sealed',
      reason: 'provider_login_expired',
    });
    expect(statuses.loginProblem('claude')?.message).toContain('Token expired.');
    expect(await statuses.givenLogin('claude')).toBeNull();

    answer = {
      ...sealedAnswer('sk-ant-oat-x'),
      sealed: { ...sealedAnswer('y').sealed, nonce: answer.sealed.nonce },
    };
    expect(await statuses.check('claude')).toMatchObject({ auth: 'missing' });
    expect(statuses.loginProblem('claude')?.code).toBe('internal');
  });

  it('keeps the login it holds while Switch cannot be asked', async () => {
    const runtime = new FakeRuntime();
    runtime.readiness = { status: 'unauthenticated', message: '', models: [] };
    answer = sealedAnswer('sk-ant-oat-given');
    const statuses = build(runtime);
    await statuses.check('claude');
    reachable = false;
    expect(await statuses.check('claude')).toMatchObject({ auth: 'ok', auth_source: 'sealed' });
    expect((await statuses.givenLogin('claude'))?.credential).toBe('sk-ant-oat-given');
    statuses.disableGiven();
    expect(await statuses.givenLogin('claude')).toBeNull();
  });
});

describe('PathProviderLocator', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'controller-path-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds a CLI by the plugin’s binary names, and reads its version', async () => {
    const script = join(dir, 'cursor-agent');
    writeFileSync(script, '#!/bin/sh\necho "2026.01.15-abc"\n');
    chmodSync(script, 0o755);
    writeFileSync(join(dir, 'claude'), 'not executable');
    const locator = new PathProviderLocator(`/nonexistent:${dir}`);
    expect(await locator.locate('cursor')).toEqual({ path: script, version: '2026.01.15-abc' });
    expect(await locator.locate('claude')).toBeNull();
    expect(await locator.locate('codex')).toBeNull();
  });

  it('reads the version of a CLI that writes in its home first, with a home of its own', async () => {
    const script = join(dir, 'opencode');
    writeFileSync(
      script,
      '#!/bin/sh\nmkdir -p "$XDG_DATA_HOME/opencode" "$HOME/.cache" || exit 1\necho 1.18.35\n'
    );
    chmodSync(script, 0o755);
    const previous = process.env.HOME;
    process.env.HOME = '/nonexistent';
    try {
      const located = await new PathProviderLocator(dir).locate('opencode');
      expect(located).toEqual({ path: script, version: '1.18.35' });
    } finally {
      process.env.HOME = previous;
    }
  });
});

describe('StatusCollector', () => {
  let dir: string;
  let store: ControllerStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'controller-status-'));
    store = ControllerStore.open(join(dir, 'controller.db'));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds a report the protocol accepts, keeping since across reports', async () => {
    let clock = NOW;
    const runtime = new FakeRuntime();
    const providers = new ProviderStatuses({
      locator: new FakeLocator(),
      runtime,
      sealed: null,
      probeCwd: dir,
      now: () => clock,
      log: silentLogger,
      onChange: () => {},
    });
    await providers.check('claude');
    const collector = new StatusCollector({
      store,
      runtime,
      providers,
      attached: () => true,
      dataDir: dir,
      workspacesDir: join(dir, 'workspaces'),
      version: '0.1.0',
      now: () => clock,
    });
    store.recordApplied('agent-1', 2, '2026-01-01T11:00:00Z');
    store.recordRestart('agent-1', NOW - 60_000);
    runtime.agents.set('agent-1', observed({ alive: true, health: health('connecting') }));
    const assignment = { revision: 7, agents: [entry()] };
    const first = await collector.collect(assignment);
    expect(statusReportSchema.safeParse({ ...first, seq: 1 }).success).toBe(true);
    expect(first.controller).toEqual({ version: '0.1.0', protocol: 2, assignment_revision: 7 });
    expect(first.providers.map((p) => p.provider)).toEqual(['claude']);
    expect(first.agents[0]).toMatchObject({
      agent_id: 'agent-1',
      applied_revision: 2,
      process: 'starting',
      since: '2026-01-01T11:30:00Z',
      sessions: { active: 2, ids: ['session-a', 'session-b'] },
      restarts_10m: 1,
    });
    expect(first.agents[0]!.directory).toBeNull();
    expect(first.machine.sessions_running).toBe(2);
    expect(first.machine.workspaces_dir).toBe(join(dir, 'workspaces'));
    expect(first.machine.disk_total_bytes).toBeGreaterThan(0);

    clock += 1000;
    runtime.agents.set(
      'agent-1',
      observed({ alive: true, health: { ...health('connecting')!, since: 'later' } })
    );
    const second = await collector.collect(assignment);
    expect(second.agents[0]!.since).toBe('2026-01-01T11:30:00Z');
    expect(statusFingerprint(second)).toBe(statusFingerprint(first));

    runtime.agents.set(
      'agent-1',
      observed({
        alive: true,
        health: health('connecting'),
        configured: { provider: 'claude', cwd: '/work/scout' },
      })
    );
    const resolved = await collector.collect(assignment);
    expect(resolved.agents[0]!.directory).toBe('/work/scout');
    expect(statusFingerprint(resolved)).not.toBe(statusFingerprint(second));

    runtime.agents.set('agent-1', observed({ failure: 'boom' }));
    const third = await collector.collect(assignment);
    expect(third.agents[0]).toMatchObject({
      process: 'failed',
      since: new Date(clock).toISOString(),
    });
    expect(statusFingerprint(third)).not.toBe(statusFingerprint(resolved));
  });
});
