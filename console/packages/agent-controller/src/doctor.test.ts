import { describe, expect, it } from 'vitest';
import { ControllerApiError } from './api';
import { type DoctorInputs, formatChecks, runDoctor } from './doctor';
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
    expect(checks.find((check) => check.name === 'Providers')?.detail).toMatch(
      /installed on PATH but none is signed in/
    );
  });

  it('fails Providers with an install message when no provider CLI is on PATH', async () => {
    const checks = await runDoctor(inputs({ locate: async () => null }));
    expect(status(checks, 'Providers')).toBe('fail');
    expect(checks.find((check) => check.name === 'Providers')?.detail).toMatch(
      /No provider CLI is installed on PATH/
    );
    expect(checks.find((check) => check.name === 'Providers')?.detail).not.toMatch(
      /none is signed in/
    );
  });

  it('fails Providers with a sign-in message when a CLI is installed but unauthenticated', async () => {
    const checks = await runDoctor(
      inputs({
        probe: async () => ({
          status: 'unauthenticated',
          message: 'Run claude auth login',
          models: [],
        }),
      })
    );
    expect(status(checks, 'claude')).toBe('warn');
    expect(status(checks, 'Providers')).toBe('fail');
    expect(checks.find((check) => check.name === 'Providers')?.detail).toMatch(
      /installed on PATH but none is signed in/
    );
    expect(checks.find((check) => check.name === 'Providers')?.detail).not.toMatch(
      /No provider CLI is installed on PATH|could not be fully verified/
    );
  });

  it('fails Providers with incomplete verification when sign-in is skipped without a shared-host bundle', async () => {
    const checks = await runDoctor(
      inputs({
        bundle: () => {
          throw new Error('no shared-host bundle');
        },
      })
    );
    expect(status(checks, 'claude')).toBe('warn');
    expect(status(checks, 'Providers')).toBe('fail');
    expect(checks.find((check) => check.name === 'Providers')?.detail).toMatch(
      /could not be fully verified/
    );
    expect(checks.find((check) => check.name === 'Providers')?.detail).not.toMatch(
      /none is signed in/
    );
  });

  it('fails Providers with incomplete verification when an auth probe throws', async () => {
    const checks = await runDoctor(
      inputs({
        probe: async () => {
          throw new Error('probe failed');
        },
      })
    );
    expect(status(checks, 'claude')).toBe('warn');
    expect(status(checks, 'Providers')).toBe('fail');
    expect(checks.find((check) => check.name === 'Providers')?.detail).toMatch(
      /could not be fully verified/
    );
    expect(checks.find((check) => check.name === 'Providers')?.detail).not.toMatch(
      /none is signed in/
    );
  });

  it('fails Providers with incomplete verification when unauthenticated and unknown providers are mixed', async () => {
    const checks = await runDoctor(
      inputs({
        locate: async (provider) =>
          provider === 'claude' || provider === 'codex'
            ? { path: `/usr/bin/${provider}`, version: '1.0.0', versionProblem: null }
            : null,
        probe: async (_bundle, provider) => {
          if (provider === 'claude')
            return {
              status: 'unauthenticated',
              message: 'Run claude auth login',
              models: [],
            };
          return { status: 'unknown', message: 'Could not determine sign-in', models: [] };
        },
      })
    );
    expect(status(checks, 'claude')).toBe('warn');
    expect(status(checks, 'codex')).toBe('warn');
    expect(status(checks, 'Providers')).toBe('fail');
    expect(checks.find((check) => check.name === 'Providers')?.detail).toMatch(
      /could not be fully verified/
    );
    expect(checks.find((check) => check.name === 'Providers')?.detail).not.toMatch(
      /none is signed in/
    );
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
