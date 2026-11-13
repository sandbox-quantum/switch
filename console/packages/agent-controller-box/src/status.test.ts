import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  generateSealingKeyPair,
  providerRuntimeIds,
  providerUnsupportedReason,
  sealProviderLogin,
} from '@switch-console/agent-providers-box';
import type { ProviderReadiness } from '@switch-console/agent-providers-box';
import { vertexCredentialFixture, writeNodeCli } from '@switch-console/agent-providers-box/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControllerApiError } from './api';
import { frontable } from './controller';
import { VertexTokenCache } from './gateway-logins';
import { type LogFields, type Logger, silentLogger } from './log';
import type { LoginCheck, LoginVerdict } from './login-check';
import type { RestState } from './rest';
import { type AgentObservation, emptyObservation } from './runtime';
import {
  type AgentAssignment,
  type ProviderStatus,
  type SealedLoginResponse,
  statusReportSchema,
} from './schemas';
import { type GivenLogin, SealedLogins } from './sealed-logins';
import {
  awakeSessions,
  mapAgentProcess,
  noSessionMidTurn,
  PathProviderLocator,
  PROVIDER_TTL_MS,
  providerStatusFrom,
  ProviderStatuses,
  StatusCollector,
  reportFingerprint,
  sessionChangeEntries,
  sessionsSent,
  statusFingerprint,
  toolStatuses,
  sessionStateOf,
  unusableLoginMessage,
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
      auto_mode: false,
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

describe('noSessionMidTurn', () => {
  const reporting = (busy: string[] | undefined, current = true) =>
    observed({ alive: true, health: { ...health('connected', null, current)!, busy } });

  it('holds while an agent host reports a session mid-turn, however many sit idle', () => {
    expect(noSessionMidTurn([reporting([])])).toBe(true);
    expect(noSessionMidTurn([reporting([]), reporting(['session-a'])])).toBe(false);
  });

  it('holds while an agent host too old to report busy sessions has any session', () => {
    expect(noSessionMidTurn([reporting(undefined)])).toBe(false);
    const empty = reporting(undefined);
    empty.health!.placements = {};
    expect(noSessionMidTurn([empty])).toBe(true);
  });

  it('counts no session for an agent host not running or whose report is not its own', () => {
    expect(noSessionMidTurn([reporting(['session-a'], false)])).toBe(true);
    expect(
      noSessionMidTurn([
        observed({ alive: false, health: { ...health('connected')!, busy: ['x'] } }),
      ])
    ).toBe(true);
    expect(noSessionMidTurn([emptyObservation(), observed({ alive: true })])).toBe(true);
    expect(noSessionMidTurn([])).toBe(true);
  });
});

describe('providerStatusFrom', () => {
  const at = '2026-01-01T00:00:00Z';
  const located = { path: '/usr/bin/claude', version: '2.0.0', versionProblem: null };
  const readiness = (status: 'authenticated' | 'unauthenticated' | 'unconfigured' | 'unknown') => ({
    status,
    message: '',
    models: [],
  });

  it('says when signing in would not fix the login, and only then', () => {
    const pinned = {
      status: 'unauthenticated' as const,
      message: 'An administrator pins where Codex keeps logins.',
      models: [],
      loginHelps: false,
    };
    expect(providerStatusFrom('codex', located, pinned, at)).toMatchObject({
      auth: 'missing',
      auth_problem: 'An administrator pins where Codex keeps logins.',
      login_helps: false,
    });
    expect(
      providerStatusFrom('codex', located, readiness('unauthenticated'), at)
    ).not.toHaveProperty('login_helps');
    expect(
      providerStatusFrom('codex', located, { ...pinned, status: 'unknown' as const }, at)
    ).toMatchObject({ auth: 'unknown', login_helps: false });
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
    expect(
      providerStatusFrom(
        'claude',
        located,
        { status: 'unknown', message: 'Claude Code may be too old.', models: [] },
        at
      )
    ).toMatchObject({ auth: 'unknown', auth_problem: 'Claude Code may be too old.' });
    expect(providerStatusFrom('claude', located, null, at)).toMatchObject({
      auth: 'unknown',
      reason: 'internal',
    });
  });
});

// Every provider the controller runs is checked, whatever their number.
const PROVIDERS = providerRuntimeIds().length;

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
    expect(runtime.probes).toBe(PROVIDERS - 1);
    expect(changes).toBe(PROVIDERS);
    expect(statuses.snapshot().find((s) => s.provider === 'cursor')?.installed).toBe(false);
    clock += PROVIDER_TTL_MS - 1;
    await statuses.refreshStale();
    expect(runtime.probes).toBe(PROVIDERS - 1);
    clock += 1;
    await statuses.refreshStale();
    expect(runtime.probes).toBe(2 * (PROVIDERS - 1));
    expect(changes).toBe(PROVIDERS);
    runtime.readiness = { status: 'unauthenticated', message: '', models: [] };
    await statuses.check('claude');
    expect(changes).toBe(PROVIDERS + 1);
    expect(statuses.snapshot().find((s) => s.provider === 'claude')?.auth).toBe('missing');
  });
});

describe('ProviderStatuses trying a login with a test prompt', () => {
  function build(answer: () => ProviderReadiness) {
    const runtime = new FakeRuntime();
    const tried: string[] = [];
    const providers = new ProviderStatuses({
      locator: new FakeLocator(),
      runtime,
      sealed: null,
      probeCwd: '/tmp',
      verify: (provider) => {
        if (provider !== 'claude') return null;
        tried.push(provider);
        return Promise.resolve(answer());
      },
      now: () => 0,
      log: silentLogger,
      onChange: () => {},
    });
    return { providers, tried };
  }
  const works: ProviderReadiness = { status: 'authenticated', message: 'OK', models: [] };
  const fails: ProviderReadiness = {
    status: 'unauthenticated',
    message: 'Claude Code is signed in but could not answer a test prompt ("Invalid API key").',
    models: [],
  };

  it('reports a login that is there but cannot answer as missing, saying why', async () => {
    const { providers } = build(() => fails);
    expect(await providers.check('claude')).toMatchObject({
      auth: 'missing',
      reason: 'provider_login_missing',
      auth_problem: fails.message,
    });
  });

  it('tries a login once it works, then again only when asked', async () => {
    const { providers, tried } = build(() => works);
    expect((await providers.check('claude')).auth).toBe('ok');
    await providers.check('claude');
    expect(tried).toHaveLength(1);
    await providers.check('claude', { verify: true });
    expect(tried).toHaveLength(2);
  });

  it('keeps trying a login that has not worked yet', async () => {
    let answer = fails;
    const { providers, tried } = build(() => answer);
    await providers.check('claude');
    answer = works;
    expect((await providers.check('claude')).auth).toBe('ok');
    expect(tried).toHaveLength(2);
  });
});

describe('ProviderStatuses taking checks made before it started', () => {
  function statuses(clock: () => number) {
    const runtime = new FakeRuntime();
    let changes = 0;
    const providers = new ProviderStatuses({
      locator: new FakeLocator(),
      runtime,
      sealed: null,
      probeCwd: '/tmp',
      now: clock,
      log: silentLogger,
      onChange: () => changes++,
    });
    return { providers, runtime, changes: () => changes };
  }

  function seeded(
    provider: string,
    auth: 'ok' | 'missing',
    at: number,
    installed = true
  ): { status: ProviderStatus; path: string | null } {
    return {
      status: {
        provider,
        installed,
        version: installed ? '1.0.0' : null,
        auth: installed ? auth : 'unknown',
        auth_source: installed && auth === 'ok' ? 'local' : null,
        checked_at: new Date(at).toISOString(),
      },
      path: installed ? `/bin/${provider}` : null,
    };
  }

  it('reports a provider signed in on its own, or not installed, without checking it again', async () => {
    const { providers, runtime, changes } = statuses(() => NOW);
    providers.seed([seeded('claude', 'ok', NOW - 1_000), seeded('cursor', 'ok', NOW, false)]);
    expect(changes()).toBe(1);
    expect(providers.snapshot().map((status) => [status.provider, status.auth])).toEqual([
      ['claude', 'ok'],
      ['cursor', 'unknown'],
    ]);
    await providers.refreshStale();
    // Every provider but the two seeded is checked here.
    expect(runtime.probes).toBe(PROVIDERS - 2);
    expect(await providers.binaryPath('claude')).toBe('/bin/claude');
  });

  it('checks for itself what a login given to the machine could change, and what is stale', async () => {
    const { providers, changes } = statuses(() => NOW);
    providers.seed([
      seeded('codex', 'missing', NOW),
      seeded('claude', 'ok', NOW - PROVIDER_TTL_MS),
    ]);
    expect(changes()).toBe(0);
    expect(providers.snapshot()).toEqual([]);
  });

  it('leaves a provider it has already checked as it found it', async () => {
    const { providers } = statuses(() => NOW);
    await providers.check('claude');
    const own = providers.snapshot().find((status) => status.provider === 'claude');
    providers.seed([seeded('claude', 'ok', NOW + 5)]);
    expect(providers.snapshot().find((status) => status.provider === 'claude')).toEqual(own);
  });
});

describe('ProviderStatuses with logins given to the machine', () => {
  const keys = generateSealingKeyPair();
  let answer: SealedLoginResponse | null;
  let reachable: boolean;
  let refusal: Error | null = null;

  function sealedAnswer(
    credential: string,
    revision = 1,
    kind: 'setup-token' | 'vertex' | 'auth-json' | 'api-key' = 'setup-token',
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

  function build(
    runtime: FakeRuntime,
    checkLogin?: LoginCheck,
    usable?: (login: GivenLogin) => boolean,
    log: Logger = silentLogger
  ) {
    return new ProviderStatuses({
      locator: new FakeLocator(),
      runtime,
      checkLogin,
      ...(usable ? { usable } : {}),
      sealed: new SealedLogins({
        client: {
          sealedLogin: async () => {
            if (!reachable) throw new Error('Switch is unreachable');
            if (refusal) throw refusal;
            return answer;
          },
        },
        keys,
        controllerId: 'controller-1',
      }),
      probeCwd: '/tmp',
      now: () => NOW,
      log,
      onChange: () => {},
    });
  }

  beforeEach(() => {
    answer = null;
    reachable = true;
    refusal = null;
  });

  describe('a login this machine cannot use (the provider gateway cannot front it)', () => {
    // As the box controller wires it with the gateway on: only gateway-backed logins.
    const gatewayOnly = (login: GivenLogin) =>
      !(login.provider === 'codex' && login.kind === 'auth-json');
    const codexSignIn = JSON.stringify({ tokens: { access_token: 'given-codex-sign-in' } });

    it("refuses Codex's 'This computer's sign-in' at once, saying why and what to give instead", async () => {
      const runtime = new FakeRuntime();
      runtime.readiness = { status: 'unauthenticated', message: 'Not signed in.', models: [] };
      answer = sealedAnswer(codexSignIn, 2, 'auth-json', 'codex');
      const statuses = build(runtime, undefined, gatewayOnly);
      const message =
        "This cloud machine can't use Codex's 'This computer's sign-in'. Give it an OpenAI API key instead.";
      expect(await statuses.check('codex', { verify: true })).toMatchObject({
        auth: 'missing',
        auth_source: 'sealed',
        reason: 'provider_login_missing',
        auth_problem: message,
      });
      // What the provider.login operation fails with, so main's Console shows it as is.
      expect(statuses.loginProblem('codex')).toEqual({ code: 'provider_login_missing', message });
      expect(await statuses.givenLogin('codex')).toBeNull();
      // Never handed to the CLI, not even for a sign-in check.
      expect(runtime.loginProbes).toEqual([]);
    });

    it('names only the kind of login, never any part of it, in the problem, the status or the logs', async () => {
      const marker = 'MARKER-7f3a-never-shown';
      const lines: string[] = [];
      const capture = (level: string) => (message: string, fields?: LogFields) =>
        lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
      const log: Logger = {
        debug: capture('debug'),
        info: capture('info'),
        warn: capture('warn'),
        error: capture('error'),
      };
      const runtime = new FakeRuntime();
      runtime.readiness = { status: 'unauthenticated', message: 'Not signed in.', models: [] };
      answer = sealedAnswer(
        JSON.stringify({ tokens: { access_token: marker } }),
        3,
        'auth-json',
        'codex'
      );
      const statuses = build(runtime, undefined, gatewayOnly, log);
      const status = await statuses.check('codex', { verify: true });
      const problem = statuses.loginProblem('codex');
      expect(problem?.message).toContain("Codex's 'This computer's sign-in'");
      expect(JSON.stringify(status)).not.toContain(marker);
      expect(JSON.stringify(problem)).not.toContain(marker);
      expect(lines.join('\n')).not.toContain(marker);
    });

    it('still uses a login it can use', async () => {
      const runtime = new FakeRuntime();
      runtime.readiness = { status: 'unauthenticated', message: 'Not signed in.', models: [] };
      answer = sealedAnswer('sk-given-openai', 1, 'api-key', 'codex');
      const statuses = build(runtime, undefined, gatewayOnly);
      expect(await statuses.check('codex')).toMatchObject({ auth: 'ok', auth_source: 'sealed' });
      expect(statuses.loginProblem('codex')).toBeNull();
    });

    it('checks every login as before where nothing says which it can use (gateway off)', async () => {
      const runtime = new FakeRuntime();
      runtime.readiness = { status: 'unauthenticated', message: 'Not signed in.', models: [] };
      answer = sealedAnswer(codexSignIn, 2, 'auth-json', 'codex');
      const statuses = build(runtime);
      await statuses.check('codex');
      expect(runtime.loginProbes.map((login) => login.kind)).toEqual(['auth-json']);
    });

    it('takes as usable exactly the logins the gateway fronts (the box wiring)', () => {
      const gateway = { vertex: new VertexTokenCache() };
      const given = (provider: 'claude' | 'codex', kind: GivenLogin['kind'], credential: string) =>
        ({ status: 'connected', provider, revision: '1', kind, credential }) as GivenLogin;
      expect(frontable(given('codex', 'auth-json', codexSignIn), gateway)).toBe(false);
      expect(frontable(given('codex', 'api-key', 'sk-openai'), gateway)).toBe(true);
      expect(frontable(given('claude', 'setup-token', 'sk-ant-oat'), gateway)).toBe(true);
      expect(frontable(given('claude', 'api-key', 'sk-ant-api'), gateway)).toBe(true);
      // Unreadable: left to the usual sign-in check, which says what is wrong.
      expect(frontable(given('claude', 'vertex', 'not json'), gateway)).toBe(true);
    });

    it('says what to give instead for each kind it can refuse, with nothing of the login', () => {
      expect(unusableLoginMessage({ provider: 'claude', kind: 'vertex' })).toMatch(
        /can't use Vertex AI in this login's region/
      );
      expect(unusableLoginMessage({ provider: 'codex', kind: 'auth-json' })).toMatch(
        /OpenAI API key instead/
      );
    });
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

  describe('a given Vertex AI login is checked with Google', () => {
    function vertexBox(verdicts: LoginVerdict[]) {
      const runtime = new FakeRuntime();
      runtime.readiness = { status: 'unauthenticated', message: 'Not signed in.', models: [] };
      answer = sealedAnswer(vertexCredentialFixture(), 5, 'vertex');
      const asked: GivenLogin[] = [];
      const statuses = build(runtime, async (login) => {
        asked.push(login);
        return verdicts.shift() ?? 'ok';
      });
      return { statuses, asked };
    }

    it('is ok only once Google gives a token', async () => {
      const { statuses, asked } = vertexBox(['ok']);
      expect(await statuses.check('claude', { verify: true })).toMatchObject({
        auth: 'ok',
        auth_source: 'sealed',
      });
      expect(asked.map((login) => login.revision)).toEqual(['5']);
      expect(await statuses.givenLogin('claude')).toMatchObject({ kind: 'vertex' });
    });

    it('reports a key Google refuses as rejected, in fixed words only', async () => {
      const { statuses } = vertexBox(['rejected']);
      const status = await statuses.check('claude', { verify: true });
      expect(status).toMatchObject({
        auth: 'expired',
        auth_source: 'sealed',
        reason: 'provider_login_expired',
        auth_problem: "Google didn't accept this key.",
      });
      expect(statuses.loginProblem('claude')).toEqual({
        code: 'login_rejected',
        message: "Google didn't accept this key.",
      });
      expect(await statuses.givenLogin('claude')).toBeNull();
      // Nothing of the key in what is reported.
      const reported = JSON.stringify(status) + JSON.stringify(statuses.loginProblem('claude'));
      expect(reported).not.toContain('PRIVATE KEY');
      expect(reported).not.toContain('acme-ai');
    });

    it('says "not checked", never ok, when Google cannot be reached, and tries again', async () => {
      const { statuses, asked } = vertexBox(['unreachable', 'ok']);
      expect(await statuses.check('claude', { verify: true })).toMatchObject({
        auth: 'unknown',
        auth_source: 'sealed',
        auth_problem: "Couldn't reach Google to check this key. It will be checked again.",
      });
      expect(statuses.loginProblem('claude')?.code).toBe('login_not_checked');
      expect(statuses.hasUnchecked()).toBe(true);
      // Not kept: the next use asks Google again, and only then uses the login.
      expect(await statuses.givenLogin('claude')).toMatchObject({ kind: 'vertex' });
      expect(asked).toHaveLength(2);
    });

    it('keeps an answer for its revision until a forced check asks again', async () => {
      const { statuses, asked } = vertexBox(['ok', 'rejected']);
      await statuses.check('claude', { verify: true });
      expect((await statuses.check('claude')).auth).toBe('ok');
      expect(asked).toHaveLength(1);
      expect((await statuses.check('claude', { verify: true })).auth).toBe('expired');
      expect(asked).toHaveLength(2);
      // A rejected key stays rejected on an ordinary check, too.
      expect((await statuses.check('claude')).auth).toBe('expired');
      expect(asked).toHaveLength(2);
    });

    it('asks again for a new revision of the login', async () => {
      const { statuses, asked } = vertexBox(['rejected', 'ok']);
      await statuses.check('claude', { verify: true });
      answer = sealedAnswer(vertexCredentialFixture(), 6, 'vertex');
      expect((await statuses.check('claude')).auth).toBe('ok');
      expect(asked.map((login) => login.revision)).toEqual(['5', '6']);
    });
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

  it('keeps "signing in would not help" only beside the message it was said of', async () => {
    const pinned = {
      status: 'unauthenticated' as const,
      message: 'An administrator pins where Codex keeps logins.',
      models: [],
      loginHelps: false,
    };
    const signsIn = new FakeRuntime();
    signsIn.readiness = pinned;
    answer = sealedAnswer('sk-given', 1, 'setup-token', 'codex');
    const given = await build(signsIn).check('codex');
    expect(given).toMatchObject({ auth: 'ok', auth_source: 'sealed' });
    expect(given).not.toHaveProperty('login_helps');
    // The machine's own login is not the one agents use now.
    expect(given).not.toHaveProperty('auth_problem');

    const refused = new FakeRuntime();
    refused.readiness = pinned;
    refused.loginReadiness = { status: 'unauthenticated', message: 'Expired.', models: [] };
    expect(await build(refused).check('codex')).not.toHaveProperty('login_helps');

    // The machine's own login is still the one in use, and signing in still would not fix it.
    const unopened = new FakeRuntime();
    unopened.readiness = pinned;
    answer = sealedAnswer(vertexCredentialFixture(), 1, 'vertex', 'codex');
    const status = await build(unopened).check('codex');
    expect(status.auth_problem).toContain('Only Claude signs in through Vertex AI.');
    expect(status).toMatchObject({ auth: 'missing', login_helps: false });

    const none = new FakeRuntime();
    none.readiness = pinned;
    answer = null;
    reachable = false;
    expect(await build(none).check('codex')).toMatchObject({ login_helps: false });
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
    const expired = await statuses.check('claude');
    expect(expired).toMatchObject({
      auth: 'expired',
      auth_source: 'sealed',
      reason: 'provider_login_expired',
    });
    expect(expired.auth_problem).toContain('Token expired.');
    expect(statuses.loginProblem('claude')?.message).toContain('Token expired.');
    expect(await statuses.givenLogin('claude')).toBeNull();

    answer = {
      ...sealedAnswer('sk-ant-oat-x'),
      sealed: { ...sealedAnswer('y').sealed, nonce: answer.sealed.nonce },
    };
    expect(await statuses.check('claude')).toMatchObject({ auth: 'missing' });
    expect(statuses.loginProblem('claude')?.code).toBe('internal');
  });

  it('doesn’t mark a given login expired when its sign-in check didn’t run, and checks again on the next use', async () => {
    // Just after a box wakes, the agents container's launcher isn't linked yet,
    // so the check can't run. That is no verdict on the login (1 Nov defect).
    const runtime = new FakeRuntime();
    runtime.readiness = { status: 'unauthenticated', message: '', models: [] };
    runtime.loginReadiness = {
      status: 'unknown',
      message: 'The sign-in check did not run (not_connected).',
      models: [],
    };
    answer = sealedAnswer(vertexCredentialFixture(), 2, 'vertex');
    const statuses = build(runtime);
    const first = await statuses.check('claude');
    expect(first).toMatchObject({ auth: 'unknown', auth_source: 'sealed' });
    expect(first.reason).toBeUndefined();
    expect(first.auth_problem).toContain('did not run');
    expect(statuses.loginProblem('claude')).toBeNull();
    expect(statuses.hasUnchecked()).toBe(true);
    expect(await statuses.givenLogin('claude')).toBeNull();

    // The launcher links: the next use checks again at once, not ten minutes later.
    runtime.loginReadiness = { status: 'authenticated', message: 'Signed in.', models: [] };
    expect((await statuses.givenLogin('claude'))?.kind).toBe('vertex');
    expect(runtime.loginProbes).toHaveLength(3);
    expect(await statuses.check('claude')).toMatchObject({ auth: 'ok', auth_source: 'sealed' });
    expect(statuses.hasUnchecked()).toBe(false);
  });

  it('keeps a given login that signed in while a later check can’t run', async () => {
    const runtime = new FakeRuntime();
    runtime.readiness = { status: 'unauthenticated', message: '', models: [] };
    answer = sealedAnswer('sk-ant-oat-given', 5);
    const statuses = build(runtime);
    expect(await statuses.check('claude')).toMatchObject({ auth: 'ok', auth_source: 'sealed' });
    runtime.loginReadiness = { status: 'unknown', message: 'not linked', models: [] };
    expect(await statuses.check('claude')).toMatchObject({ auth: 'ok', auth_source: 'sealed' });
    expect((await statuses.givenLogin('claude'))?.credential).toBe('sk-ant-oat-given');
    // A new revision that can't be checked isn't used on trust.
    answer = sealedAnswer('sk-ant-oat-newer', 6);
    expect(await statuses.check('claude')).toMatchObject({
      auth: 'unknown',
      auth_source: 'sealed',
    });
    expect(await statuses.givenLogin('claude')).toBeNull();
  });

  it('keeps a given login when Switch refuses the read with 403 hosted_v2_off, and never treats it as withdrawn', async () => {
    const runtime = new FakeRuntime();
    runtime.readiness = { status: 'unauthenticated', message: '', models: [] };
    answer = sealedAnswer('sk-ant-oat-given', 8);
    const statuses = build(runtime);
    expect(await statuses.check('claude')).toMatchObject({ auth: 'ok', auth_source: 'sealed' });
    // Hosted agents switched off on the server while the box is still up.
    refusal = new ControllerApiError(
      403,
      'hosted_v2_off',
      'This server does not support cloud agents.',
      false,
      null
    );
    expect(await statuses.check('claude')).toMatchObject({ auth: 'ok', auth_source: 'sealed' });
    expect((await statuses.givenLogin('claude'))?.credential).toBe('sk-ant-oat-given');
  });

  it('never keeps a withdrawn login because a sign-in check can’t run', async () => {
    const runtime = new FakeRuntime();
    runtime.readiness = { status: 'unauthenticated', message: '', models: [] };
    answer = sealedAnswer('sk-ant-oat-given', 7);
    const statuses = build(runtime);
    expect(await statuses.check('claude')).toMatchObject({ auth: 'ok', auth_source: 'sealed' });
    // Withdrawn in Switch while the box's check can't run: nothing is used.
    answer = null;
    runtime.loginReadiness = { status: 'unknown', message: 'not linked', models: [] };
    expect(await statuses.check('claude')).toMatchObject({
      auth: 'missing',
      reason: 'provider_login_missing',
    });
    expect(await statuses.givenLogin('claude')).toBeNull();
    expect(statuses.hasUnchecked()).toBe(false);
  });

  it('still marks a given login expired when its sign-in check runs and fails', async () => {
    const runtime = new FakeRuntime();
    runtime.readiness = { status: 'unauthenticated', message: '', models: [] };
    runtime.loginReadiness = { status: 'unauthenticated', message: 'Token expired.', models: [] };
    answer = sealedAnswer('sk-ant-oat-expired');
    const statuses = build(runtime);
    expect(await statuses.check('claude')).toMatchObject({
      auth: 'expired',
      reason: 'provider_login_expired',
    });
    // Cached as before: no second probe within the TTL.
    expect(await statuses.givenLogin('claude')).toBeNull();
    expect(runtime.loginProbes).toHaveLength(1);
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

/** `path` as a pattern: Windows names a CLI with PATHEXT's casing, `.CMD`. */
function escape(path: string): string {
  return path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('PathProviderLocator', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'controller-path-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds a CLI by the plugin’s binary names, and reads its version', async () => {
    const script = await writeNodeCli(dir, 'cursor-agent', 'console.log("2026.01.15-abc")');
    writeFileSync(join(dir, 'claude'), 'not executable');
    const locator = new PathProviderLocator(
      () => ['/nonexistent', dir].join(delimiter),
      join(dir, 'probe-home')
    );
    expect(await locator.locate('cursor')).toEqual({
      path: expect.stringMatching(new RegExp(`^${escape(script)}$`, 'i')),
      version: '2026.01.15-abc',
      versionProblem: null,
    });
    expect(await locator.locate('claude')).toBeNull();
    expect(await locator.locate('codex')).toBeNull();
  });

  it('finds Google’s agy for Antigravity ahead of a legacy antigravity-acp, on every OS', async () => {
    expect(providerUnsupportedReason('antigravity', 'win32')).toBeNull();
    const legacy = await writeNodeCli(dir, 'antigravity-acp', 'console.log("1.1.1")');
    const locator = new PathProviderLocator(() => dir, join(dir, 'probe-home'));
    expect(await locator.locate('antigravity')).toEqual({
      path: expect.stringMatching(new RegExp(`^${escape(legacy)}$`, 'i')),
      version: '1.1.1',
      versionProblem: null,
    });
    const agy = await writeNodeCli(dir, 'agy', 'console.log("1.5.1")');
    expect(await locator.locate('antigravity')).toEqual({
      path: expect.stringMatching(new RegExp(`^${escape(agy)}$`, 'i')),
      version: '1.5.1',
      versionProblem: null,
    });
  });

  it('reads the version of a CLI that writes in its home first, with a home of its own', async () => {
    const script = await writeNodeCli(
      dir,
      'opencode',
      `const { mkdirSync } = require('node:fs');
       const { join } = require('node:path');
       mkdirSync(join(process.env.XDG_DATA_HOME, 'opencode'), { recursive: true });
       mkdirSync(join(process.env.HOME, '.cache'), { recursive: true });
       console.log('1.18.35');`
    );
    const previous = process.env.HOME;
    process.env.HOME = '/nonexistent';
    try {
      const located = await new PathProviderLocator(() => dir, join(dir, 'probe-home')).locate(
        'opencode'
      );
      expect(located).toEqual({
        path: expect.stringMatching(new RegExp(`^${escape(script)}$`, 'i')),
        version: '1.18.35',
        versionProblem: null,
      });
    } finally {
      process.env.HOME = previous;
    }
  });
});

describe('a CLI whose version cannot be read', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'controller-version-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('says why, so the report can carry it', async () => {
    const script = await writeNodeCli(
      dir,
      'opencode',
      'console.error("EROFS: read-only file system"); process.exit(1);'
    );
    const located = await new PathProviderLocator(() => dir, join(dir, 'probe-home')).locate(
      'opencode'
    );
    expect(located).toEqual({
      path: expect.stringMatching(new RegExp(`^${escape(script)}$`, 'i')),
      version: null,
      versionProblem: 'exited 1: EROFS: read-only file system',
    });
    expect(
      providerStatusFrom('opencode', located, null, '2026-01-01T00:00:00Z').version_problem
    ).toBe('exited 1: EROFS: read-only file system');
  });
});

describe('toolStatuses', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'controller-tools-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // PATH is looked up as this machine does, so the POSIX case runs off Windows.
  it.skipIf(process.platform === 'win32')('reports git and gh as found on PATH', async () => {
    writeFileSync(join(dir, 'git'), '#!/bin/sh\n');
    chmodSync(join(dir, 'git'), 0o755);
    writeFileSync(join(dir, 'gh'), 'not executable');
    expect(await toolStatuses(`/nonexistent:${dir}`, 'linux', join(dir, 'tools'))).toEqual([
      { tool: 'git', state: 'ok' },
      { tool: 'gh', state: 'missing' },
    ]);
  });

  it('reports git and gh as unsupported on Windows', async () => {
    const noVendorTools = join(dir, 'tools');
    expect(await toolStatuses(dir, 'win32', noVendorTools)).toEqual([
      { tool: 'git', state: 'unsupported' },
      { tool: 'gh', state: 'unsupported' },
    ]);
  });

  it('reports each vendor tool a session here has set up', async () => {
    const tools = join(dir, 'tools');
    mkdirSync(tools);
    const entry = (state: string) => ({
      version: '1.2.3',
      target: 'linux-x64',
      state,
      detail: null,
      checked_at: '2026-10-08T00:00:00Z',
    });
    writeFileSync(
      join(tools, 'status.json'),
      JSON.stringify({ zcli: entry('failed'), excli: entry('ok'), wincli: entry('unsupported') })
    );
    expect(await toolStatuses('/nonexistent', 'linux', tools)).toEqual([
      { tool: 'git', state: 'missing' },
      { tool: 'gh', state: 'missing' },
      { tool: 'excli', state: 'ok' },
      { tool: 'wincli', state: 'unsupported' },
      { tool: 'zcli', state: 'missing' },
    ]);
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

  it("reports the agents' disk on a split box, and 0 of 0 (no figure) when it's unknown, never the data folder's", async () => {
    const runtime = new FakeRuntime();
    const providers = new ProviderStatuses({
      locator: new FakeLocator(),
      runtime,
      sealed: null,
      probeCwd: dir,
      now: () => NOW,
      log: silentLogger,
      onChange: () => {},
    });
    const collectorWith = (disk?: () => Promise<{ free: number; total: number } | null>) =>
      new StatusCollector({
        store,
        runtime,
        providers,
        tools: async () => [],
        attached: () => true,
        dataDir: dir,
        ...(disk ? { disk } : {}),
        workspacesDir: join(dir, 'workspaces'),
        version: '0.1.0',
        updatedBy: 'self',
        now: () => NOW,
        meminfo: async () => null,
      });
    const assignment = { revision: 1, agents: [] };
    const agents = await collectorWith(async () => ({
      free: 12_000_000_000,
      total: 15_000_000_000,
    })).collect(assignment);
    expect(agents.machine).toMatchObject({
      disk_free_bytes: 12_000_000_000,
      disk_total_bytes: 15_000_000_000,
    });
    // Marked as the agents' volume, so Switch shows it.
    expect(agents.machine.disk_scope).toBe('workspace');
    expect(statusReportSchema.safeParse({ ...agents, seq: 1 }).success).toBe(true);

    for (const unknown of [async () => null, async () => Promise.reject(new Error('lost'))]) {
      const report = await collectorWith(unknown).collect(assignment);
      expect(report.machine).toMatchObject({ disk_free_bytes: 0, disk_total_bytes: 0 });
      expect(report.machine.disk_scope).toBe('unknown');
      expect(statusReportSchema.safeParse({ ...report, seq: 1 }).success).toBe(true);
    }

    // No reader (not a split box): the data folder's own file system, as before.
    const own = await collectorWith().collect(assignment);
    expect(own.machine.disk_total_bytes).toBeGreaterThan(0);
    // The data folder may be the controller's own volume: never marked as the agents'.
    expect(own.machine.disk_scope).toBe('unknown');
  });

  it("reports the box's /proc/meminfo figures when there are some, and leaves them out when not", async () => {
    const runtime = new FakeRuntime();
    const providers = new ProviderStatuses({
      locator: new FakeLocator(),
      runtime,
      sealed: null,
      probeCwd: dir,
      now: () => NOW,
      log: silentLogger,
      onChange: () => {},
    });
    const collectorWith = (meminfo: () => Promise<{ anon: number; cached: number } | null>) =>
      new StatusCollector({
        store,
        runtime,
        providers,
        tools: async () => [],
        attached: () => true,
        dataDir: dir,
        workspacesDir: join(dir, 'workspaces'),
        version: '0.1.0',
        updatedBy: 'self',
        now: () => NOW,
        meminfo,
      });
    const assignment = { revision: 1, agents: [] };
    const read = await collectorWith(async () => ({
      anon: 940_496 * 1024,
      cached: 571_544 * 1024,
    })).collect(assignment);
    expect(read.machine).toMatchObject({
      mem_anon_bytes: 963_067_904,
      mem_cached_bytes: 585_261_056,
    });
    expect(statusReportSchema.safeParse({ ...read, seq: 1 }).success).toBe(true);

    const none = await collectorWith(async () => null).collect(assignment);
    expect(none.machine).not.toHaveProperty('mem_anon_bytes');
    expect(none.machine).not.toHaveProperty('mem_cached_bytes');
    expect(statusReportSchema.safeParse({ ...none, seq: 1 }).success).toBe(true);
    // A new reading alone does not count as a change worth reporting early.
    expect(statusFingerprint(read)).toBe(statusFingerprint(none));
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
    const awakeSeen: [string, number][] = [];
    const agentsSeen: string[][] = [];
    const collector = new StatusCollector({
      store,
      runtime,
      providers,
      tools: async () => [
        { tool: 'git', state: 'ok' },
        { tool: 'gh', state: 'missing' },
      ],
      attached: () => true,
      // The box valve: its cap is reported, and it hears each agent's awake count.
      onAgentAwake: (agentId, awake) => void awakeSeen.push([agentId, awake]),
      onAgentsSeen: (ids) => void agentsSeen.push([...ids]),
      sessionsMax: () => 12,
      valveHosts: () => ({ joined: 2, hosts: 3 }),
      valveMemory: () => 'unprotected',
      // The guard's note goes as a fixed code and its figures, never text (status extras).
      guard: {
        held: () => null,
        oomKills: () => 0,
        boxNote: () => ({ code: 'unexplained', boxBytes: 5_000_000_000, shmemBytes: null }),
      },
      gatewayCounts: () => ({ agents: 4, refused: 1, callsToday: 37, capped: false }),
      // The guard is on and the valve is off here: only the guard's count is sent.
      boxCounts: () => ({ guardStops: 3, valveParks: null }),
      dataDir: dir,
      workspacesDir: join(dir, 'workspaces'),
      version: '0.1.0',
      updatedBy: 'self',
      now: () => clock,
    });
    store.recordApplied('agent-1', 2, '2026-01-01T11:00:00Z');
    store.recordRestart('agent-1', NOW - 60_000);
    runtime.agents.set('agent-1', observed({ alive: true, health: health('connecting') }));
    const assignment = { revision: 7, agents: [entry()] };
    const first = await collector.collect(assignment);
    expect(statusReportSchema.safeParse({ ...first, seq: 1 }).success).toBe(true);
    expect(first.controller).toEqual({
      version: '0.1.0',
      protocol: 2,
      assignment_revision: 7,
      updated_by: 'self',
      started_at: '2026-01-01T12:00:00.000Z',
    });
    expect(first.providers.map((p) => p.provider)).toEqual(['claude']);
    expect(first.tools).toEqual([
      { tool: 'git', state: 'ok' },
      { tool: 'gh', state: 'missing' },
    ]);
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
    expect(first.machine.sessions_max).toBe(12);
    expect(first.machine).toMatchObject({ valve_hosts: 3, valve_hosts_joined: 2 });
    // A box whose memory the valve has never read is reported, so an operator sees it.
    expect(first.machine.valve_memory).toBe('unprotected');
    expect(first.machine.memory_note).toBe('unexplained');
    expect(first.machine.memory_note_box_bytes).toBe(5_000_000_000);
    expect(first.machine.memory_note_shmem_bytes).toBeUndefined();
    expect(first.machine).toMatchObject({
      gateway_agents: 4,
      gateway_refused: 1,
      gateway_calls_today: 37,
      gateway_capped: false,
    });
    expect(first.machine.guard_stops).toBe(3);
    expect(first.machine).not.toHaveProperty('valve_parks');
    expect(awakeSeen).toEqual([['agent-1', 2]]);
    expect(agentsSeen).toEqual([['agent-1']]);
    expect(first.machine.workspaces_dir).toBe(join(dir, 'workspaces'));
    expect(first.machine.disk_total_bytes).toBeGreaterThan(0);

    clock += 1000;
    runtime.agents.set(
      'agent-1',
      observed({ alive: true, health: { ...health('connecting')!, since: 'later' } })
    );
    const second = await collector.collect(assignment);
    // The process start, not the report's time: it only changes on a restart.
    expect(second.controller.started_at).toBe('2026-01-01T12:00:00.000Z');
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

    runtime.agents.set(
      'agent-1',
      observed({
        alive: true,
        health: {
          ...health('connected')!,
          sessions: { 'session-a': 'parked', 'session-b': 'parked' },
        },
      })
    );
    const parked = await collector.collect(assignment);
    expect(parked.agents[0]!.sessions).toEqual({ active: 2, ids: ['session-a', 'session-b'] });
    expect(parked.machine.sessions_running).toBe(0);

    // Messages waiting for room: reported with the oldest, and only while any wait.
    runtime.agents.set(
      'agent-1',
      observed({
        alive: true,
        health: {
          ...health('connected')!,
          waitingForRoom: { count: 2, oldestSince: '2026-01-01T11:59:00.000Z' },
        },
      })
    );
    const waiting = await collector.collect(assignment);
    expect(waiting.agents[0]!.waiting_for_room).toEqual({
      count: 2,
      oldest_since: '2026-01-01T11:59:00.000Z',
    });
    expect(statusReportSchema.safeParse({ ...waiting, seq: 2 }).success).toBe(true);
    runtime.agents.set(
      'agent-1',
      observed({
        alive: true,
        health: { ...health('connected')!, waitingForRoom: { count: 0, oldestSince: null } },
      })
    );
    expect((await collector.collect(assignment)).agents[0]).not.toHaveProperty('waiting_for_room');

    runtime.agents.set('agent-1', observed({ failure: 'boom' }));
    const third = await collector.collect(assignment);
    expect(third.agents[0]).toMatchObject({
      process: 'failed',
      since: new Date(clock).toISOString(),
    });
    expect(statusFingerprint(third)).not.toBe(statusFingerprint(resolved));
  });
});

describe('statusFingerprint', () => {
  it('changes when only a provider’s auth problem changes', () => {
    const report = (authProblem?: string) =>
      ({
        controller: { assignment_revision: 1 },
        providers: [
          {
            provider: 'claude',
            installed: true,
            version: '2.1.0',
            auth: 'missing',
            ...(authProblem ? { auth_problem: authProblem } : {}),
          },
        ],
        tools: [],
        agents: [],
      }) as unknown as Parameters<typeof statusFingerprint>[0];
    expect(statusFingerprint(report('Invalid API key'))).not.toBe(
      statusFingerprint(report('Not logged in'))
    );
    expect(statusFingerprint(report())).not.toBe(statusFingerprint(report('Invalid API key')));
  });
});

describe('reportFingerprint', () => {
  const report = (session: 'parked' | 'waking' | 'active' | null) =>
    ({
      controller: { assignment_revision: 1 },
      providers: [],
      tools: [],
      agents: [
        {
          agent_id: 'user-a-lead',
          applied_revision: 1,
          process: 'running',
          attached: true,
          sessions: { active: 1, ids: ['session-lead'] },
          session,
        },
      ],
    }) as unknown as Parameters<typeof reportFingerprint>[0];

  it('changes when only where the sessions stand changes, which statusFingerprint does not see', () => {
    // 26 Oct: parked, then waking, then active, with nothing else changing.
    const [parked, waking, active] = (['parked', 'waking', 'active'] as const).map(report);
    expect(new Set([parked, waking, active].map(reportFingerprint)).size).toBe(3);
    expect(new Set([parked, waking, active].map(statusFingerprint)).size).toBe(1);
    expect(reportFingerprint(report(null))).not.toBe(reportFingerprint(parked));
  });

  it('changes when messages start or stop waiting for room, so the card shows within a poll', () => {
    const idle = report('parked');
    const waiting = structuredClone(idle);
    (waiting.agents[0] as { waiting_for_room?: unknown }).waiting_for_room = {
      count: 1,
      oldest_since: '2026-10-27T12:00:00Z',
    };
    expect(reportFingerprint(waiting)).not.toBe(reportFingerprint(idle));
    expect(statusFingerprint(waiting)).toBe(statusFingerprint(idle));
  });
});

describe('sessionChangeEntries (tail log)', () => {
  // A rerun on a test box: reply at +3.16 s, 'waking' reached Switch at +3.5 s,
  // 'active' at +9.0 s. The log must show each move with its times.
  const t0 = Date.parse('2026-10-27T08:30:00.000Z');
  const report = (seq: number, session: 'parked' | 'waking' | 'active' | null) =>
    ({
      seq,
      agents: [
        { agent_id: 'user-a-lead', session },
        { agent_id: 'user-a-qa', session: 'parked' },
      ],
    }) as unknown as Parameters<typeof sessionChangeEntries>[1];

  it('logs one entry per agent whose sessions moved, with ids, states and times only', () => {
    const before = sessionsSent(report(1, 'parked'));
    const entries = sessionChangeEntries(before, report(2, 'waking'), {
      checkedAt: t0 + 3_400,
      sentAt: t0 + 3_500,
      skippedAt: null,
    });
    expect(entries).toEqual([
      {
        message: 'Status report carried a session change',
        fields: {
          agent_id: 'user-a-lead',
          seq: 2,
          from: 'parked',
          to: 'waking',
          checked_at: '2026-10-27T08:30:03.400Z',
          sent_at: '2026-10-27T08:30:03.500Z',
          reason: 'seen at this check',
        },
      },
    ]);
  });

  it('names the skipped check when a change waited behind a report on its way', () => {
    const before = sessionsSent(report(2, 'waking'));
    const [entry] = sessionChangeEntries(before, report(3, 'active'), {
      checkedAt: t0 + 8_900,
      sentAt: t0 + 9_000,
      skippedAt: t0 + 3_900,
    });
    expect(entry!.fields).toMatchObject({
      from: 'waking',
      to: 'active',
      reason: 'a check was skipped while another report was on its way',
      skipped_at: '2026-10-27T08:30:03.900Z',
    });
  });

  it('logs nothing for the first report or when nothing moved', () => {
    const times = { checkedAt: t0, sentAt: t0, skippedAt: null };
    expect(sessionChangeEntries(null, report(1, 'active'), times)).toEqual([]);
    expect(
      sessionChangeEntries(sessionsSent(report(1, 'active')), report(2, 'active'), times)
    ).toEqual([]);
  });
});

describe('sessions_running', () => {
  // Seen on a test box: an agent parked with 6 placements, reported as 6 running,
  // so a cloud machine that had ever chatted never read as idle to Core's sweep.
  it('counts only awake sessions, so a parked box reports 0', () => {
    const placements = { s1: 'r1', s2: 'r2', s3: 'r3' };
    const at = (sessions: Record<string, 'active' | 'waking' | 'parked'>) =>
      ({ ...health('connected'), placements, sessions }) as NonNullable<AgentObservation['health']>;
    expect(awakeSessions(at({ s1: 'parked', s2: 'parked', s3: 'parked' }), 3)).toBe(0);
    expect(awakeSessions(at({ s1: 'parked', s2: 'active', s3: 'waking' }), 3)).toBe(2);
  });

  it('counts every placement for a host that does not say where its sessions stand', () => {
    expect(awakeSessions(health('connected')!, 2)).toBe(2);
  });
});

describe('sessionStateOf', () => {
  const withSessions = (
    sessions: Record<string, 'active' | 'waking' | 'parked'> | undefined,
    alive = true
  ) =>
    observed({
      alive,
      health: {
        ...health('connected'),
        ...(sessions ? { sessions } : {}),
      } as AgentObservation['health'],
    });

  it('reports the most awake session: waking, then active, then parked', () => {
    expect(sessionStateOf(withSessions({ a: 'parked', b: 'active', c: 'waking' }))).toBe('waking');
    expect(sessionStateOf(withSessions({ a: 'parked', b: 'active' }))).toBe('active');
    expect(sessionStateOf(withSessions({ a: 'parked', b: 'parked' }))).toBe('parked');
  });

  it('reports nothing when the watcher is not live, has no sessions, or is too old to say', () => {
    expect(sessionStateOf(withSessions({ a: 'active' }, false))).toBeNull();
    expect(sessionStateOf(withSessions({}))).toBeNull();
    expect(sessionStateOf(withSessions(undefined))).toBeNull();
  });
});

describe('a resting agent', () => {
  const resting: RestState = { kind: 'resting', sessions: ['session-a', 'session-b'] };
  const waking: RestState = { kind: 'waking', sessions: ['session-a', 'session-b'] };
  const stoppedHost = observed({ alive: false, health: null });

  function mapRest(
    observation: AgentObservation,
    rest: Parameters<typeof mapAgentProcess>[0]['rest'],
    options: {
      rowValue?: AgentRow | null;
      assigned?: AgentAssignment;
      streamCarries?: boolean;
    } = {}
  ) {
    return mapAgentProcess({
      assignment: options.assigned ?? entry(),
      row: options.rowValue === undefined ? row() : options.rowValue,
      observation,
      relayAttached: false,
      nowMs: NOW,
      rest,
      streamCarries: options.streamCarries ?? true,
    });
  }

  it('reports running, never stopped or crashed, attached while Switch has it on the stream', () => {
    // Without resting, the same stopped host maps to crashed.
    expect(map(stoppedHost)).toMatchObject({ process: 'crashed' });
    expect(mapRest(stoppedHost, resting)).toEqual({ process: 'running', attached: true });
    expect(mapRest(stoppedHost, resting, { streamCarries: false })).toEqual({
      process: 'running',
      attached: false,
    });
  });

  it('shows a failed start as failed, whatever resting says', () => {
    const failed = row({
      failure: { revision: 2, reason: 'internal', detail: 'The shared host launcher failed' },
    });
    expect(mapRest(stoppedHost, waking, { rowValue: failed })).toMatchObject({
      process: 'failed',
      reason: 'internal',
    });
    expect(mapRest(stoppedHost, resting, { rowValue: failed })).toMatchObject({
      process: 'failed',
    });
  });

  it('shows an agent its owner stopped as stopped', () => {
    expect(
      mapRest(stoppedHost, resting, { assigned: entry({ desired_state: 'stopped' }) })
    ).toEqual({ process: 'stopped', attached: false });
  });

  it('reports running while woken and its host is not connected yet, then the host’s own state', () => {
    expect(mapRest(stoppedHost, waking)).toEqual({ process: 'running', attached: true });
    expect(mapRest(observed({ alive: true, health: health('connecting') }), waking)).toEqual({
      process: 'running',
      attached: true,
    });
    expect(mapRest(observed({ alive: true, health: health('connected') }), waking)).toMatchObject({
      process: 'running',
      since: '2026-01-01T11:30:00Z',
    });
  });

  it('leaves an agent the memory guard stopped to the guard’s own state', () => {
    expect(mapRest(stoppedHost, { kind: 'out_of_memory' })).toMatchObject({ process: 'crashed' });
  });

  describe('in the report', () => {
    let dir: string;
    let store: ControllerStore;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'controller-rest-status-'));
      store = ControllerStore.open(join(dir, 'controller.db'));
    });
    afterEach(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });

    async function collect(
      rest: Parameters<typeof mapAgentProcess>[0]['rest'],
      observation: AgentObservation
    ) {
      const runtime = new FakeRuntime();
      const providers = new ProviderStatuses({
        locator: new FakeLocator(),
        runtime,
        sealed: null,
        probeCwd: dir,
        now: () => NOW,
        log: silentLogger,
        onChange: () => {},
      });
      const collector = new StatusCollector({
        store,
        runtime,
        providers,
        tools: async () => [],
        attached: () => false,
        rest: () => rest ?? null,
        streamCarries: () => true,
        dataDir: dir,
        workspacesDir: join(dir, 'workspaces'),
        version: '0.1.0',
        updatedBy: 'self',
        now: () => NOW,
      });
      store.recordApplied('agent-1', 2, '2026-01-01T11:00:00Z');
      runtime.agents.set('agent-1', observation);
      return collector.collect({ revision: 7, agents: [entry()] });
    }

    it('reads as parked with its sessions, counts 0 awake, and changes nothing a reconcile is decided on', async () => {
      const parked = await collect(
        null,
        observed({
          alive: true,
          health: {
            ...health('connected')!,
            sessions: { 'session-a': 'parked', 'session-b': 'parked' },
          },
        })
      );
      const asleep = await collect(resting, stoppedHost);
      expect(statusReportSchema.safeParse({ ...asleep, seq: 1 }).success).toBe(true);
      expect(asleep.agents[0]).toMatchObject({
        process: 'running',
        attached: true,
        session: 'parked',
        sessions: { active: 2, ids: ['session-a', 'session-b'] },
      });
      expect(asleep.machine.sessions_running).toBe(0);
      expect(asleep.agents[0]!.reason).toBeUndefined();
      expect(asleep.agents[0]!.process).toBe(parked.agents[0]!.process);
      expect(asleep.agents[0]!.sessions).toEqual(parked.agents[0]!.sessions);
    });

    it('reads as waking and counts it awake while its host comes back, so the box is not stopped mid-wake', async () => {
      const report = await collect(waking, stoppedHost);
      expect(report.agents[0]).toMatchObject({ process: 'running', session: 'waking' });
      expect(report.machine.sessions_running).toBe(1);
    });
  });
});
