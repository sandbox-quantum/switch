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
    expect(formatChecks(checks)).toMatch(/\[OK\] +claude/);
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

describe('doctor guidance', () => {
  it('keeps failures visible and provides next steps for local setup problems', async () => {
    const checks = await runDoctor(
      inputs({
        nodeVersion: 'v22.12.0',
        bundle: () => {
          throw new Error('bundle missing');
        },
        secrets: {
          description: 'locked store',
          persistent: true,
          startupWarning: () => null,
          get: async () => {
            throw new Error('access denied');
          },
          set: async () => {},
          delete: async () => {},
        },
        service: async () => 'stopped',
      })
    );
    expect(checks.find((check) => check.name === 'Node')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('install Node 22.13'),
    });
    expect(checks.find((check) => check.name === 'Credential')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('Unlock the secret store'),
    });
    expect(checks.find((check) => check.name === 'Shared host')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('--shared-host-bundle'),
    });
    expect(checks.find((check) => check.name === 'claude')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('sign-in not checked'),
    });
    expect(checks.find((check) => check.name === 'Service')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('start the existing service'),
    });
  });

  it('offers retry guidance without treating failed remote checks as successful', async () => {
    const checks = await runDoctor(
      inputs({
        exchange: async () => {
          throw new Error('offline');
        },
        latest: async () => {
          throw new Error('offline');
        },
        probe: async () => {
          throw new Error('cannot start');
        },
        service: async () => {
          throw new Error('no user manager');
        },
      })
    );
    expect(checks.find((check) => check.name === 'Server')).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('network and proxy'),
    });
    expect(checks.find((check) => check.name === 'Version')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('update --check'),
    });
    expect(checks.find((check) => check.name === 'claude')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('provider CLI runs as the controller user'),
    });
    expect(checks.find((check) => check.name === 'Service')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('service manager and its logs'),
    });
  });
});

describe('formatChecks', () => {
  it('aligns names and details with explicit status marks, including continuation lines', () => {
    expect(
      formatChecks([
        { name: 'Node', status: 'ok', detail: 'v24' },
        { name: 'Service', status: 'warn', detail: 'stopped\nStart it again.' },
        { name: 'Server', status: 'fail', detail: 'offline' },
      ])
    ).toBe(
      [
        '[OK]    Node     v24',
        '[WARN]  Service  stopped',
        '                 Start it again.',
        '[ERROR] Server   offline',
      ].join('\n')
    );
    expect(formatChecks([])).toBe('');
  });

  it('strips controls from diagnostics and only emits its own colour when requested', () => {
    const checks = [
      { name: '\x1b[31mServer\x1b[0m', status: 'fail' as const, detail: '\x1b[2Joffline\r' },
    ];
    const uncoloured = formatChecks(checks);
    expect(uncoloured).toBe('[ERROR] Server  offline');
    const coloured = formatChecks(checks, { color: true });
    expect(coloured).toContain('\x1b[31m[ERROR]\x1b[0m');
    expect(coloured).not.toContain('\x1b[2J');
  });
});
