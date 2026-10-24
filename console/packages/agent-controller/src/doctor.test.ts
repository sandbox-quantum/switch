import { describe, expect, it } from 'vitest';
import { ControllerApiError } from './api';
import { checkGroup, type DoctorInputs, doctorJson, formatChecks, runDoctor } from './doctor';
import { PLAIN } from './format';
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
    expect(formatChecks(PLAIN, checks)).toContain('  ok    claude');
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
    expect(checks.find((check) => check.name === 'Server')?.fix).toMatch(
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

  it('gives a fix for every failure it knows how to fix, and none for what passed', async () => {
    const checks = await runDoctor(inputs({ identity: null, nodeVersion: 'v20.0.0' }));
    expect(checks.find((check) => check.name === 'Enrollment')?.fix).toMatch(
      /^switch-agent-controller enroll --server <url> --code <code>/
    );
    expect(checks.find((check) => check.name === 'Node')?.fix).toBe('Install Node 22.13 or later.');
    expect(checks.filter((check) => check.status === 'ok' && check.fix !== null)).toEqual([]);
  });
});

describe('formatChecks', () => {
  it('groups checks under Machine, Server and Providers, with fixes and a count', async () => {
    const text = formatChecks(
      PLAIN,
      await runDoctor(
        inputs({ latest: async () => ({ version: '0.3.0', packageUrl: 'https://x.invalid' }) })
      )
    );
    const lines = text.split('\n');
    expect(lines[0]).toBe('Machine');
    expect(lines).toContain('Server');
    expect(lines).toContain('Providers');
    expect(text).toContain('  warn  Version      0.2.0; 0.3.0 is available');
    expect(text).toContain('        Fix: switch-agent-controller update');
    expect(lines.at(-1)).toBe('8 ok, 1 warning, 0 failed');
    expect(text).not.toMatch(/\u001b\[/);
  });

  it('marks with coloured symbols on a terminal', async () => {
    const text = formatChecks({ rich: true }, await runDoctor(inputs()));
    expect(text).toContain('\u001b[32m✓\u001b[39m');
    expect(text).not.toContain('ok    claude');
  });

  it('puts every check in a group', () => {
    expect(checkGroup('Node')).toBe('Machine');
    expect(checkGroup('Credential')).toBe('Server');
    expect(checkGroup('codex')).toBe('Providers');
    expect(checkGroup('Providers')).toBe('Providers');
  });
});

describe('doctorJson', () => {
  it('reports every check, and fails when any check failed', async () => {
    const ready = JSON.parse(doctorJson(await runDoctor(inputs())));
    expect(ready.ok).toBe(true);
    expect(ready.checks[0]).toEqual({ name: 'Node', status: 'ok', detail: 'v22.13.0', fix: null });
    const broken = JSON.parse(doctorJson(await runDoctor(inputs({ platform: 'freebsd' }))));
    expect(broken.ok).toBe(false);
  });
});
