import { describe, expect, it } from 'vitest';
import { ControllerApiError } from './api';
import { checksJson, type DoctorInputs, formatChecks, runDoctor } from './doctor';
import { MemorySecretStore } from './secrets';

function inputs(overrides: Partial<DoctorInputs> = {}): DoctorInputs {
  return {
    version: '0.2.0',
    nodeVersion: 'v22.13.0',
    platform: 'linux',
    dataDir: '/data',
    identity: {
      controllerId: 'controller-1',
      server: 'https://switch.example.invalid',
      name: 'build-box',
      enrolledAt: '2026-10-01T00:00:00Z',
    },
    revokedAt: null,
    secrets: new MemorySecretStore({ 'controller-credential': 'swcc_x' }, 'test'),
    bundle: () => '/opt/shared-host.mjs',
    exchange: async () => ({}),
    locate: async (provider) =>
      provider === 'claude'
        ? { path: '/usr/bin/claude', version: '2.1.0', versionProblem: null }
        : null,
    probe: async () => ({ status: 'authenticated', message: 'Signed in.', models: [] }),
    service: async () => 'running',
    latest: async () => ({ version: '0.2.0', packageUrl: 'https://example.invalid/p.tgz' }),
    separateUsers: null,
    ...overrides,
  };
}

const status = (checks: Awaited<ReturnType<typeof runDoctor>>, name: string) =>
  checks.find((check) => check.name === name)?.status;

describe('doctor', () => {
  it('passes a machine that is ready', async () => {
    const checks = await runDoctor(inputs());
    expect(checks.filter((check) => check.status !== 'ok')).toEqual([]);
    expect(formatChecks(checks)).toContain('ok    claude');
  });

  it('passes a ready Windows machine, which Console runs rather than a service', async () => {
    const checks = await runDoctor(
      inputs({
        platform: 'win32',
        service: async () => {
          throw new Error('not asked on Windows');
        },
      })
    );
    expect(checks.filter((check) => check.status !== 'ok')).toEqual([]);
    expect(checks.find((check) => check.name === 'Service')?.detail).toMatch(/Switch Console/);
  });

  it('fails a platform the controller does not run on', async () => {
    expect(status(await runDoctor(inputs({ platform: 'freebsd' })), 'Platform')).toBe('fail');
  });

  it('fails an old Node, and a machine with no signed-in provider', async () => {
    const checks = await runDoctor(
      inputs({
        nodeVersion: 'v22.12.0',
        probe: async () => ({
          status: 'unauthenticated',
          message: 'Run claude auth login',
          models: [],
        }),
      })
    );
    expect(status(checks, 'Node')).toBe('fail');
    expect(status(checks, 'claude')).toBe('warn');
    expect(status(checks, 'Providers')).toBe('fail');
  });

  it('points at the proxy when the server answers, but not as the Switch API', async () => {
    const checks = await runDoctor(
      inputs({
        exchange: async () => {
          throw new ControllerApiError(200, 'invalid_response', 'not the protocol', false, null);
        },
      })
    );
    expect(checks.find((check) => check.name === 'Server')?.detail).toMatch(
      /send \/v1 to switch-core/
    );
  });

  it('stops at enrollment when there is none, and says how to enroll', async () => {
    const checks = await runDoctor(inputs({ identity: null }));
    expect(status(checks, 'Enrollment')).toBe('fail');
    expect(checks.find((check) => check.name === 'Server')).toBeUndefined();
  });

  it('warns about a newer release, a stopped service, and a failed update check', async () => {
    expect(
      status(
        await runDoctor(
          inputs({ latest: async () => ({ version: '0.3.0', packageUrl: 'https://x.invalid' }) })
        ),
        'Version'
      )
    ).toBe('warn');
    expect(status(await runDoctor(inputs({ service: async () => 'stopped' })), 'Service')).toBe(
      'warn'
    );
    const offline = await runDoctor(
      inputs({
        latest: async () => {
          throw new Error('offline');
        },
      })
    );
    expect(offline.find((check) => check.name === 'Version')?.detail).toMatch(/offline/);
  });
});

describe('doctor output', () => {
  it("puts each problem's fix under it and ends with a count", async () => {
    const text = formatChecks(
      await runDoctor(inputs({ identity: null, service: async () => 'not-installed' }))
    );
    const lines = text.split('\n');
    const enrollment = lines.findIndex((line) => line.startsWith('FAIL  Enrollment'));
    expect(lines[enrollment]).toMatch(/\/data is not enrolled\.$/);
    expect(lines[enrollment + 1]).toMatch(/^ +fix: switch-agent-controller enroll --server/);
    const service = lines.findIndex((line) => line.startsWith('warn  Service'));
    expect(lines[service + 1]).toMatch(/fix: switch-agent-controller install-service/);
    expect(lines.at(-1)).toBe('1 problem, 1 warning.');
  });

  it('prints no fix for a check that passed', async () => {
    const text = formatChecks(await runDoctor(inputs()));
    expect(text).not.toContain('fix:');
    expect(text.split('\n').at(-1)).toMatch(/^All \d+ checks passed\.$/);
  });

  it('lines the fix up under the detail', async () => {
    const lines = formatChecks(await runDoctor(inputs({ nodeVersion: 'v20.0.0' }))).split('\n');
    const node = lines.findIndex((line) => line.startsWith('FAIL  Node'));
    expect(lines[node + 1]?.indexOf('fix:')).toBe(lines[node]?.indexOf('v20.0.0'));
  });

  it('colours only on request', async () => {
    const checks = await runDoctor(inputs({ platform: 'freebsd' }));
    expect(formatChecks(checks)).not.toContain('\u001b[');
    const coloured = formatChecks(checks, { color: true });
    expect(coloured).toContain('\u001b[31mFAIL');
    expect(coloured.replace(/\u001b\[\d+m/g, '')).toBe(formatChecks(checks));
  });

  it('prints the checks as JSON, saying whether any failed', async () => {
    const passing = JSON.parse(checksJson(await runDoctor(inputs())));
    expect(passing.ok).toBe(true);
    expect(passing.checks.map((check: { name: string }) => check.name)).toContain('claude');
    const failing = JSON.parse(checksJson(await runDoctor(inputs({ platform: 'freebsd' }))));
    expect(failing.ok).toBe(false);
    expect(failing.checks.find((check: { name: string }) => check.name === 'Platform')).toEqual({
      name: 'Platform',
      status: 'fail',
      detail: 'freebsd is not supported.',
      fix: 'Use Linux, macOS or Windows.',
    });
  });
});
