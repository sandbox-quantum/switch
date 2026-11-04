import { describe, expect, it } from 'vitest';
import { ControllerApiError } from './api';
import { type DoctorInputs, doctorDocument, doctorPassed, runDoctor } from './doctor';
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
    expect(doctorPassed(checks)).toBe(true);
    expect(checks.map((check) => check.name)).toContain('claude');
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
});

describe('every problem carries its fix', () => {
  it('leaves no warning or failure as a bare mark, however the machine is broken', async () => {
    const broken: DoctorInputs[] = [
      inputs({ identity: null }),
      inputs({ nodeVersion: 'v20.0.0', platform: 'freebsd' }),
      inputs({ revokedAt: '2026-10-02T00:00:00Z' }),
      inputs({ secrets: new MemorySecretStore({}, 'test') }),
      inputs({
        exchange: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      }),
      inputs({
        exchange: async () => {
          throw new ControllerApiError(401, 'unauthorized', 'no such controller', false, null);
        },
      }),
      inputs({
        bundle: () => {
          throw new Error('no bundle here');
        },
      }),
      inputs({
        probe: async () => ({ status: 'unauthenticated', message: 'run login', models: [] }),
      }),
      inputs({
        probe: async () => {
          throw new Error('the probe timed out');
        },
      }),
      inputs({ locate: async () => null }),
      inputs({ service: async () => 'stopped' }),
      inputs({ service: async () => 'not-installed' }),
      inputs({
        service: async () => {
          throw new Error('no service manager here');
        },
      }),
      inputs({ latest: async () => ({ version: '9.9.9', packageUrl: 'https://x.invalid' }) }),
      inputs({
        latest: async () => {
          throw new Error('offline');
        },
      }),
      inputs({
        separateUsers: {
          agentsDir: '/var/lib/switch-agents/1001',
          agentUsers: 4,
          controllerUnit: 'switch-agent-controller-1001.service',
        },
        service: async () => 'stopped',
      }),
    ];
    for (const machine of broken) {
      const checks = await runDoctor(machine);
      expect(checks.some((check) => check.status !== 'ok')).toBe(true);
      expect(checks.filter((check) => check.status !== 'ok' && !check.fix)).toEqual([]);
    }
  });
});

describe('doctorDocument', () => {
  it('carries the documented keys, and `ok` agrees with the exit decision', async () => {
    const checks = await runDoctor(inputs());
    const document = doctorDocument('0.2.0', checks);
    expect(document.schema).toBe('switch-agent-controller/doctor@1');
    expect(document.version).toBe('0.2.0');
    expect(document.ok).toBe(doctorPassed(checks));
    expect(Object.keys(document.checks[0]!).sort()).toEqual(['detail', 'fix', 'name', 'status']);
    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
    expect(doctorDocument('0.2.0', await runDoctor(inputs({ identity: null }))).ok).toBe(false);
  });
});
