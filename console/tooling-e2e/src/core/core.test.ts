import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENTIC_SCENARIO_DIR, loadAgenticScenarios } from '../agentic/scenario-file.ts';
import { BROWSER_SCENARIOS } from '../browser/index.ts';
import { olderThanFrom, timestampMs } from '../cleanup.ts';
import { FAST_SCENARIOS } from '../fast/index.ts';
import { SCENARIOS as PROVIDER_SCENARIOS } from '../provider/scenarios.ts';
import { laneFrom, loadEnv, MissingConfigError, strictFrom, type HarnessEnv } from './env.ts';
import { assertAllowed, ReadOnlyEnvironmentError } from './guard.ts';
import { isHarnessArtifact, isValidArtifactName, RunContext } from './run.ts';
import { admit, assertValidHeaders, headerProblems, type ScenarioHeader } from './scenario.ts';
import { IssuedSecrets } from './secrets.ts';

const BASE = {
  SWITCH_API_URL: 'http://switch.invalid/',
  SWITCH_GATEWAY_ADMIN_EMAIL: 'admin@example.invalid',
  SWITCH_GATEWAY_ADMIN_PASSWORD: 'placeholder',
  SWITCH_AGENT_REGISTRATION_TOKEN: 'placeholder',
  SWITCH_E2E_ENVIRONMENT: 'ephemeral',
};

describe('configuration', () => {
  it('needs only the Switch server, and strips a trailing slash', () => {
    const env = loadEnv('fast', BASE, {});
    expect(env.switch.apiUrl).toBe('http://switch.invalid');
    expect(env.strict).toBe(false);
  });

  it('names every missing variable at once', () => {
    expect(() => loadEnv('fast', {}, {})).toThrow(MissingConfigError);
    try {
      loadEnv('fast', {}, {});
    } catch (error) {
      expect((error as MissingConfigError).missing).toEqual(Object.keys(BASE));
    }
  });

  it('refuses an unknown environment or lane', () => {
    expect(() => loadEnv('fast', { ...BASE, SWITCH_E2E_ENVIRONMENT: 'qa' }, {})).toThrow(/qa/);
    expect(() => laneFrom({ SWITCH_E2E_LANE: 'slow' }, {})).toThrow(/slow/);
    expect(laneFrom({}, {})).toBeNull();
  });

  it('reads the lane and strict mode from .env as well as the environment', () => {
    expect(laneFrom({}, { SWITCH_E2E_LANE: 'fast' })).toBe('fast');
    expect(strictFrom({}, { SWITCH_E2E_STRICT: '1' })).toBe(true);
    expect(loadEnv('fast', BASE, { SWITCH_E2E_STRICT: '1' }).strict).toBe(true);
    expect(laneFrom({ SWITCH_E2E_LANE: 'provider' }, { SWITCH_E2E_LANE: 'fast' })).toBe('provider');
  });
});

describe('read-only guard', () => {
  it('lets reads and logins through against prod, and nothing else', () => {
    expect(() => assertAllowed('prod', 'GET', '/gateway/rooms')).not.toThrow();
    expect(() => assertAllowed('prod', 'POST', '/gateway/auth/login')).not.toThrow();
    expect(() => assertAllowed('prod', 'POST', '/gateway/rooms')).toThrow(ReadOnlyEnvironmentError);
    expect(() => assertAllowed('prod', 'DELETE', '/agents/x')).toThrow(ReadOnlyEnvironmentError);
    expect(() => assertAllowed('prod', 'POST', '/gateway/auth/login/../rooms')).toThrow();
  });

  it('allows writes everywhere else', () => {
    for (const environment of ['ephemeral', 'local', 'dev', 'staging'] as const) {
      expect(() => assertAllowed(environment, 'POST', '/gateway/rooms')).not.toThrow();
    }
  });
});

describe('run naming', () => {
  it('gives each scope distinct, handle-safe names', () => {
    const run = new RunContext('abc123');
    const first = run.scope();
    const second = run.scope();
    expect(first.name('snd')).toBe('e2e-abc123a-snd');
    expect(second.name('snd')).toBe('e2e-abc123b-snd');
    expect(run.owns('e2e-abc123b-snd')).toBe(true);
    expect(run.owns('e2e-zzz999a-snd')).toBe(false);
  });

  it('refuses a name too long for a handle, or one handed out twice', () => {
    const scope = new RunContext('abc123').scope();
    expect(() => scope.name('much-too-long')).toThrow(/Shorten/);
    scope.name('room');
    expect(() => scope.name('room')).toThrow(/already/);
  });

  it('fits every provider agent role', () => {
    for (const role of ['opencode', 'antigrav', 'cursor', 'claude', 'codex']) {
      expect(isValidArtifactName(`e2e-abc123a-${role}`)).toBe(true);
    }
  });
});

const header = (overrides: Partial<ScenarioHeader> = {}): ScenarioHeader => ({
  id: 'some-scenario',
  covers: ['list_rooms', 'POST /agents/{agent_id}/message'],
  lane: 'fast',
  environments: ['ephemeral', 'dev'],
  owner: 'platform',
  requires: [],
  ...overrides,
});

const env = (overrides: Partial<HarnessEnv> = {}): HarnessEnv => ({
  ...loadEnv('fast', BASE, {}),
  ...overrides,
});

describe('scenario headers', () => {
  it('accepts operation names and routes, and reports every problem', () => {
    expect(headerProblems(header())).toEqual([]);
    expect(
      headerProblems(
        header({ id: 'Bad Id', covers: ['post message'], environments: [], owner: '' })
      )
    ).toHaveLength(4);
  });

  it('keeps provider scenarios off prod', () => {
    expect(headerProblems(header({ lane: 'provider', environments: ['prod'] }))).toHaveLength(1);
  });

  it('refuses a duplicated id', () => {
    expect(() => assertValidHeaders([header(), header()])).toThrow(/used by another/);
  });

  it('holds for every scenario in the suite, with ids unique across lanes', () => {
    const fast = FAST_SCENARIOS.map((scenario) => scenario.header);
    const provider = PROVIDER_SCENARIOS.map((scenario) => scenario.header);
    const browser = BROWSER_SCENARIOS.map((scenario) => scenario.header);
    const agentic = loadAgenticScenarios(AGENTIC_SCENARIO_DIR).map((scenario) => scenario.header);
    expect(() => assertValidHeaders([...fast, ...provider, ...browser, ...agentic])).not.toThrow();
    expect(fast.every((h) => h.lane === 'fast')).toBe(true);
    expect(provider.every((h) => h.lane === 'provider')).toBe(true);
    expect(browser.every((h) => h.lane === 'browser')).toBe(true);
  });
});

describe('admission', () => {
  it('runs a scenario of this lane and environment with its prerequisites met', () => {
    expect(admit(header(), env())).toEqual({ run: true });
  });

  it('passes over the other lane and unlisted environments without failing', () => {
    expect(admit(header({ lane: 'provider' }), env())).toMatchObject({
      run: false,
      failure: false,
    });
    expect(admit(header(), env({ environment: 'staging' }))).toMatchObject({
      run: false,
      failure: false,
    });
  });

  it('skips on a missing prerequisite, and fails on one when strict', () => {
    const needsUi = header({ requires: ['gateway-ui'] });
    expect(admit(needsUi, env({ gatewayUiUrl: null }))).toMatchObject({
      run: false,
      failure: false,
    });
    expect(admit(needsUi, env({ strict: true, gatewayUiUrl: null }))).toMatchObject({
      run: false,
      failure: true,
      reason: expect.stringContaining('SWITCH_GATEWAY_UI_URL'),
    });
  });
});

describe('cleanup scope', () => {
  it('takes every name the harness builds, and none of the e2e- names people choose', () => {
    const scope = new RunContext('k3x9q2').scope();
    for (const role of ['sender', 'room', 'hub.a', 'm-1']) {
      expect(isHarnessArtifact(scope.name(role))).toBe(true);
    }
    for (const name of [
      'e2e-709-slack',
      'e2e-bundle-6d5e40',
      'e2e-hub-isolated',
      'e2e-hub-shared',
      'e2e-k3x9q2a',
      'my-e2e-k3x9q2a-x',
    ]) {
      expect(isHarnessArtifact(name)).toBe(false);
    }
  });
});

describe('cleanup age floor', () => {
  it('reads server timestamps with an offset, and refuses ones without', () => {
    expect(timestampMs('2026-10-16 17:08:52.123456+00:00')).toBe(
      Date.UTC(2026, 9, 16, 17, 8, 52, 123)
    );
    expect(timestampMs('2026-10-16T17:08:52Z')).toBe(Date.UTC(2026, 9, 16, 17, 8, 52));
    expect(() => timestampMs('2026-10-16 17:08:52')).toThrow(/UTC offset/);
  });

  it('requires --older-than', () => {
    expect(olderThanFrom(['--older-than', '120'])).toBe(120);
    expect(olderThanFrom(['--older-than', '0'])).toBe(0);
    expect(() => olderThanFrom([])).toThrow(/--older-than/);
    expect(() => olderThanFrom(['--older-than', '-1'])).toThrow(/--older-than/);
  });
});

describe('issued secrets', () => {
  it('appends each credential on its own line, and records nothing without a file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'e2e-secrets-'));
    try {
      const file = path.join(dir, 'issued');
      const issued = new IssuedSecrets(file);
      issued.record('agent-key-0123456789');
      issued.record('');
      issued.record('cookie-value-abcdef');
      expect(readFileSync(file, 'utf8')).toBe('agent-key-0123456789\ncookie-value-abcdef\n');
      expect(() => new IssuedSecrets(null).record('ignored-value')).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
