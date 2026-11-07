import { describe, expect, it } from 'vitest';
import { ControllerApiError } from './api';
import { createStyle } from './cli-output';
import {
  type Check,
  type DoctorInputs,
  checksJson,
  formatChecks,
  formatReport,
  runDoctor,
  summarizeChecks,
} from './doctor';
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
    expect(formatChecks(checks, createStyle(false))).toContain('ok    claude');
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
    const server = checks.find((check) => check.name === 'Server');
    expect(server?.detail).toMatch(/not as the Switch API/);
    expect(server?.fix).toMatch(/send \/v1 to switch-core/);
  });

  it('stops at enrollment when there is none, and says how to enroll', async () => {
    const checks = await runDoctor(inputs({ identity: null }));
    expect(status(checks, 'Enrollment')).toBe('fail');
    expect(checks.find((check) => check.name === 'Enrollment')?.fix).toMatch(
      /switch-agent-controller enroll --server <url> --code <code>/
    );
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
  const plain = createStyle(false);
  const color = createStyle(true);
  const checks: Check[] = [
    { name: 'Node', status: 'ok', detail: 'v22.13.0' },
    { name: 'Service', status: 'warn', detail: 'Not installed.', fix: 'Run: install-service' },
    { name: 'Enrollment', status: 'fail', detail: '/data is not enrolled.', fix: 'Run: enroll' },
  ];

  it('puts a problem’s fix under it, lined up with the details', () => {
    expect(formatChecks(checks, plain).split('\n')).toEqual([
      'ok    Node        v22.13.0',
      'warn  Service     Not installed.',
      '                  Fix: Run: install-service',
      'FAIL  Enrollment  /data is not enrolled.',
      '                  Fix: Run: enroll',
    ]);
  });

  it('writes no escape codes unless the style is in colour', () => {
    expect(formatReport(checks, plain)).not.toContain(String.fromCharCode(27));
    expect(formatReport(checks, color)).toContain(`${String.fromCharCode(27)}[31mFAIL`);
  });

  it('counts the problems and warnings, and says when the machine is ready', () => {
    expect(summarizeChecks(checks, plain)).toBe(
      '1 problem, 1 warning. Fix what is marked FAIL, then run doctor again.'
    );
    expect(summarizeChecks(checks.slice(0, 2), plain)).toBe(
      '1 warning. This machine can run agents.'
    );
    expect(summarizeChecks(checks.slice(0, 1), plain)).toBe(
      'All checks passed. This machine is ready to run agents.'
    );
    expect(summarizeChecks([...checks, ...checks], plain)).toMatch(/^2 problems, 2 warnings\./);
  });

  it('reports every check for a script, with a null where there is no fix', () => {
    expect(checksJson(checks)).toEqual({
      ok: false,
      checks: [
        { name: 'Node', status: 'ok', detail: 'v22.13.0', fix: null },
        { name: 'Service', status: 'warn', detail: 'Not installed.', fix: 'Run: install-service' },
        {
          name: 'Enrollment',
          status: 'fail',
          detail: '/data is not enrolled.',
          fix: 'Run: enroll',
        },
      ],
    });
    expect(checksJson(checks.slice(0, 2)).ok).toBe(true);
  });

  it('gives every problem doctor finds a fix of its own', async () => {
    const failing = await runDoctor(
      inputs({
        nodeVersion: 'v22.12.0',
        platform: 'freebsd',
        identity: null,
        locate: async () => null,
        service: async () => 'not-installed',
      })
    );
    const problems = failing.filter((check) => check.status !== 'ok');
    expect(problems.map((check) => check.name)).toEqual([
      'Node',
      'Platform',
      'Enrollment',
      'Providers',
      'Service',
    ]);
    for (const problem of problems) expect(problem.fix, problem.name).toBeTruthy();
  });
});
