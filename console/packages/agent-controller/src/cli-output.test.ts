import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Sqlite from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DoctorModule from './doctor';
import { runDoctor } from './doctor';
import { main, VERSION } from './main';
import { dataLayout } from './paths';
import { PROTOCOL_VERSION } from './schemas';
import { CONTROLLER_CREDENTIAL, FileSecretStore } from './secrets';
import type * as SeparateUsersModule from './separate-users';
import { findSeparateUsersConfig, separateUserNames } from './separate-users';
import type * as ServiceModule from './service';
import { installService, uninstallService } from './service';
import { ControllerStore } from './store';
import type * as SystemdModule from './systemd-runtime';
import { SystemdRuntime, systemctl } from './systemd-runtime';
import type * as UpdateModule from './update';
import { latestRelease } from './update';

vi.mock('./doctor', async (original) => ({
  ...(await original<typeof DoctorModule>()),
  runDoctor: vi.fn(),
}));
vi.mock('./service', async (original) => ({
  ...(await original<typeof ServiceModule>()),
  installService: vi.fn(),
  uninstallService: vi.fn(),
}));
vi.mock('./update', async (original) => ({
  ...(await original<typeof UpdateModule>()),
  latestRelease: vi.fn(),
}));
vi.mock('./separate-users', async (original) => ({
  ...(await original<typeof SeparateUsersModule>()),
  findSeparateUsersConfig: vi.fn(async () => null),
}));

vi.mock('./systemd-runtime', async (original) => ({
  ...(await original<typeof SystemdModule>()),
  systemctl: vi.fn(),
}));

let dir: string;
let stdout: string;
let stderr: string;
let ttyDescriptor: PropertyDescriptor | undefined;
const identity = {
  controllerId: 'controller-example',
  name: 'Example machine',
  server: 'https://switch.example.invalid',
  enrolledAt: '2026-10-01T00:00:00Z',
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controller-output-'));
  vi.mocked(findSeparateUsersConfig).mockResolvedValue(null);
  stdout = '';
  stderr = '';
  ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  vi.stubEnv('NO_COLOR', '1');
});
afterEach(() => {
  if (ttyDescriptor) Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
  else Reflect.deleteProperty(process.stdout, 'isTTY');
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
function enrolled(): ControllerStore {
  const store = ControllerStore.open(dataLayout(dir).database);
  store.saveIdentity(identity);
  return store;
}
async function run(command: string, ...args: string[]): Promise<number> {
  stdout = '';
  stderr = '';
  return main([command, '--data-dir', dir, ...args]);
}

describe('CLI output', () => {
  it('keeps the exact version, protocol and help exit codes', async () => {
    expect(await main(['--version'])).toBe(0);
    expect(stdout).toBe(`${VERSION}\n`);
    stdout = '';
    expect(await main(['--protocol'])).toBe(0);
    expect(stdout).toBe(`${PROTOCOL_VERSION}\n`);
    stdout = '';
    expect(await main(['--help'])).toBe(0);
    expect(stdout).toContain('Switch agent controller\n\nUsage:');
    expect(stdout).toContain('status [--data-dir <dir>] [--shared-host-bundle <path>] [--json]');
    expect(stdout).toContain('Environment and credentials');
    expect(stdout).not.toContain('\x1b');
    expect(await main([])).toBe(2);
  });
  it('shows actionable not-enrolled output and preserves its exit code in JSON', async () => {
    expect(await run('status')).toBe(1);
    expect(stdout).toContain('Controller status');
    expect(stdout).toContain('[ERROR] Not enrolled.');
    expect(stdout).toContain(`--data-dir '${dir}'`);
    expect(stdout).not.toContain('\x1b');
    expect(await run('status', '--json')).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({
      schemaVersion: 1,
      command: 'status',
      dataDir: dir,
      identity: null,
      agents: [],
    });
    expect(stderr).toBe('');
  });
  it('projects local agent state without credentials or private definitions', async () => {
    const store = enrolled();
    store.saveAssignment(
      {
        revision: 3,
        agents: [
          {
            agent_id: 'agent-example',
            revision: 2,
            desired_state: 'stopped',
            definition: {
              name: 'Example agent',
              display_name: null,
              icon_url: null,
              provider: 'claude',
              model: null,
              advanced_config: { privateSetting: 'DO_NOT_PRINT' },
              instructions: 'PRIVATE_INSTRUCTIONS',
              auto_approve: false,
              auto_mode: false,
              directory: null,
              isolation: 'shared',
            },
          },
        ],
      },
      null,
      '2026-10-01T00:00:00Z'
    );
    store.close();
    await new FileSecretStore(dataLayout(dir).secrets).set(
      CONTROLLER_CREDENTIAL,
      'EXAMPLE_CREDENTIAL_DO_NOT_PRINT'
    );
    expect(await run('status', '--json')).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.identity).toEqual(identity);
    expect(report.credential).toBe('present');
    expect(report.assignment).toEqual({ kind: 'saved', revision: 3 });
    expect(report.agents).toEqual([
      {
        id: 'agent-example',
        name: 'Example agent',
        provider: 'claude',
        desiredState: 'stopped',
        revision: 2,
        appliedRevision: null,
        process: 'stopped',
        reason: null,
        detail: null,
        observationError: null,
        unit: null,
      },
    ]);
    expect(stdout).not.toMatch(/DO_NOT_PRINT|PRIVATE_INSTRUCTIONS|advanced_config|instructions/);
    expect(await run('status')).toBe(0);
    expect(stdout).toContain('Agents');
    expect(stdout).toContain('Example agent (agent-example)');
    expect(stdout).toContain('Local process observations only');
    expect(stdout).not.toContain('\x1b');
    const changed = ControllerStore.open(dataLayout(dir).database);
    const cached = changed.cachedAssignment();
    if (cached.kind !== 'saved') throw new Error('Expected the synthetic assignment');
    changed.saveAssignment(
      {
        ...cached.assignment,
        agents: cached.assignment.agents.map((agent) => ({ ...agent, desired_state: 'running' })),
      },
      null,
      '2026-10-01T00:00:00Z'
    );
    changed.recordApplied('agent-example', 2, '2026-10-01T00:00:00Z');
    changed.close();
    expect(await run('status')).toBe(0);
    expect(stdout).toMatch(/Process:\s+crashed/);
    expect(stdout).toContain('[ERROR] internal');
    expect(stdout).toContain(`switch-agent-controller doctor --data-dir '${dir}'`);
  });
  it.skipIf(process.platform === 'win32')(
    'reports unknown process state when separate-user observation is denied',
    async () => {
      const config: SeparateUsersModule.SeparateUsersConfig = {
        v: 1,
        user: 'controller',
        uid: 1000,
        gid: 1000,
        dataDir: dir,
        agentsDir: join(dir, 'agents'),
        agentUsers: 2,
        node: process.execPath,
        bundle: join(dir, 'shared-host.mjs'),
        releasesDir: null,
      };
      vi.mocked(findSeparateUsersConfig).mockResolvedValue(config);
      vi.mocked(systemctl).mockResolvedValue('active\n');
      vi.spyOn(SystemdRuntime.prototype, 'observe').mockRejectedValue(
        new Error('EACCES: permission denied')
      );
      const store = enrolled();
      store.saveAssignment(
        {
          revision: 3,
          agents: [
            {
              agent_id: 'agent-example',
              revision: 2,
              desired_state: 'running',
              definition: {
                name: 'Example agent',
                display_name: null,
                icon_url: null,
                provider: 'claude',
                model: null,
                advanced_config: {},
                instructions: '',
                auto_approve: false,
                auto_mode: false,
                directory: join(dir, 'workspace'),
                isolation: 'shared',
              },
            },
          ],
        },
        null,
        '2026-10-01T00:00:00Z'
      );
      store.recordApplied('agent-example', 2, '2026-10-01T00:00:00Z');
      const slot = store.claimAgentUser('agent-example', 2, '2026-10-01T00:00:00Z');
      if (slot === null) throw new Error('Expected a synthetic agent user');
      store.close();
      const unit = separateUserNames(config.uid).agentUnit(slot);
      expect(await run('status', '--json')).toBe(0);
      expect(JSON.parse(stdout).agents[0]).toMatchObject({
        process: null,
        reason: null,
        detail: null,
        observationError: 'EACCES: permission denied',
        unit: `${unit} is active`,
      });
      expect(systemctl).toHaveBeenCalledWith(['is-active', unit]);
      expect(await run('status')).toBe(0);
      expect(stdout).toMatch(/Process:\s+unknown/);
      expect(stdout).toContain(`[WARN] ${unit} is active`);
      expect(stdout).toContain('EACCES: permission denied');
      expect(stdout).toContain(
        "Run status as the controller user or a member of the agents' group."
      );
      expect(stdout).not.toMatch(/crashed|\[ERROR\]|Next: run switch-agent-controller doctor/);
    }
  );

  it('distinguishes absent, empty and unreadable assignments without leaking malformed contents', async () => {
    enrolled().close();
    expect(await run('status', '--json')).toBe(0);
    expect(JSON.parse(stdout).assignment).toEqual({ kind: 'none', revision: null });
    const again = ControllerStore.open(dataLayout(dir).database);
    again.saveAssignment({ revision: 4, agents: [] }, null, '2026-10-01T00:00:00Z');
    again.close();
    expect(await run('status', '--json')).toBe(0);
    expect(JSON.parse(stdout).assignment).toEqual({ kind: 'saved', revision: 4 });
    expect(JSON.parse(stdout).agents).toEqual([]);
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof Sqlite;
    const raw = new DatabaseSync(dataLayout(dir).database);
    raw.prepare('UPDATE assignment SET body = ?').run('PRIVATE_MALFORMED_CONTENT');
    raw.close();
    expect(await run('status', '--json')).toBe(0);
    expect(JSON.parse(stdout).assignment).toEqual({ kind: 'unreadable', revision: null });
    expect(stdout).not.toContain('PRIVATE_MALFORMED_CONTENT');
  });
  it('retains revoked identity without reading its credential', async () => {
    const store = enrolled();
    store.markRevoked('2026-10-02T00:00:00Z');
    store.close();
    const get = vi.spyOn(FileSecretStore.prototype, 'get');
    expect(await run('status', '--json')).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      revokedAt: '2026-10-02T00:00:00Z',
      credential: 'not-checked',
    });
    expect(get).not.toHaveBeenCalled();
  });
  it.each(['status', 'doctor'])(
    'returns one JSON document on %s argument and state failures',
    async (command) => {
      expect(await run(command, '--json', '--unknown')).toBe(2);
      expect(JSON.parse(stdout)).toMatchObject({
        schemaVersion: 1,
        command,
        exitCode: 2,
        error: { message: expect.stringContaining('Unknown option') },
      });
      expect(stderr).toBe('');
      const store = enrolled();
      store.saveSecretStoreKind('unavailable');
      store.close();
      expect(await run(command, '--json')).toBe(2);
      expect(JSON.parse(stdout).error.message).toContain('does not know');
      expect(stderr).toBe('');
    }
  );
  it.each([
    [{ name: 'Enrollment', status: 'fail' as const, detail: 'Enroll with a code from Switch.' }, 1],
    [
      { name: 'Version', status: 'warn' as const, detail: 'Run switch-agent-controller update.' },
      0,
    ],
    [{ name: 'Node', status: 'ok' as const, detail: 'v24.14.0' }, 0],
  ] as const)('keeps doctor JSON and human diagnostics consistent: %j', async (check, exit) => {
    vi.mocked(runDoctor).mockResolvedValue([check]);
    expect(await run('doctor', '--json')).toBe(exit);
    expect(JSON.parse(stdout)).toEqual({ schemaVersion: 1, command: 'doctor', checks: [check] });
    expect(await run('doctor')).toBe(exit);
    expect(stdout).toContain('Machine checks');
    expect(stdout).toContain(check.name);
    expect(stdout).toContain(check.detail);
    expect(stdout).not.toContain('\x1b');
  });
  it('reports service installation and removal without changing their operations', async () => {
    enrolled().close();
    vi.mocked(installService).mockResolvedValue({
      file: '/example/controller.service',
      notes: ['Service starts at login.'],
    });
    expect(await run('install-service')).toBe(0);
    expect(installService).toHaveBeenCalledOnce();
    expect(stdout).toContain('Service installation');
    expect(stdout).toContain('[OK] Installed and started');
    expect(stdout).toContain('/example/controller.service');
    expect(stdout).not.toContain('\x1b');
    vi.mocked(uninstallService).mockResolvedValue(false);
    expect(await run('uninstall-service')).toBe(0);
    expect(stdout).toContain('[INFO] No service was installed.');
    expect(stdout).toContain('Enrollment and data are kept.');
    vi.mocked(uninstallService).mockResolvedValue(true);
    expect(await run('uninstall-service')).toBe(0);
    expect(stdout).toContain('[OK] Stopped and removed the service.');
  });
  it('uses terminal colour only for human reports, never JSON', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    vi.stubEnv('NO_COLOR', undefined);
    vi.stubEnv('TERM', 'xterm');
    expect(await run('status')).toBe(1);
    expect(stdout).toContain('\x1b[');
    expect(await run('status', '--json')).toBe(1);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stdout).not.toContain('\x1b');
    vi.stubEnv('NO_COLOR', '');
    await run('status');
    expect(stdout).not.toContain('\x1b');
    vi.stubEnv('NO_COLOR', undefined);
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    await run('status');
    expect(stdout).not.toContain('\x1b');
  });

  it('quotes custom data directories without shell interpolation and strips error controls', async () => {
    const custom = join(dir, "machine's $workspace");
    expect(await main(['status', '--data-dir', custom])).toBe(1);
    const quoted =
      process.platform === 'win32'
        ? `'${custom.replace(/'/g, "''")}'`
        : `'${custom.replace(/'/g, "'\\''")}'`;
    expect(stdout).toContain(`--data-dir ${quoted}`);
    expect(await main(['bad\x1b[31m-command\x1b[0m'])).toBe(2);
    expect(stderr).not.toContain('\x1b');
    expect(stderr.trimEnd().split('\n').at(-1)).toBe(
      "switch-agent-controller: Unknown command 'bad-command'."
    );
  });

  it('keeps update checks read-only and their exit codes unchanged', async () => {
    vi.mocked(latestRelease).mockResolvedValue(null);
    expect(await run('update', '--check')).toBe(1);
    expect(stdout).toContain('[WARN] No switch-agent-controller release');
    vi.mocked(latestRelease).mockResolvedValue({
      version: VERSION,
      packageUrl: 'https://example.invalid/package.tgz',
    });
    expect(await run('update', '--check')).toBe(0);
    expect(stdout).toContain('[OK] This is the latest release');
    vi.mocked(latestRelease).mockResolvedValue({
      version: '99.0.0',
      packageUrl: 'https://example.invalid/package.tgz',
    });
    expect(await run('update', '--check')).toBe(0);
    expect(stdout).toContain('[INFO] 99.0.0 is available');
    expect(stdout).toContain('switch-agent-controller update');
    expect(stdout).not.toContain('\x1b');
  });
});
