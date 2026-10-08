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
      provider === 'claude' ? { path: '/usr/bin/claude', version: '2.1.0' } : null,
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
