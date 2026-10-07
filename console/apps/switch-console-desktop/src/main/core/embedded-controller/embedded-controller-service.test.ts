import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { MovedAgentsHereError } from '@shared/core/agent-migration/agent-migration';
import type {
  EmbeddedControllerPhase,
  EmbeddedControllerStateEvent,
} from '@shared/core/embedded-controller/embedded-controller';
import {
  controllerDataDir,
  credentialSecretKey,
  EnrollmentFile,
  turnOffWatchers,
  wipeControllerIdentity,
} from './controller-files';
import {
  type EmbeddedControllerDeps,
  EmbeddedControllerService,
  type ManagementPort,
  WINDOWS_UNSUPPORTED,
} from './embedded-controller-service';
import { fakeSpawn, type SpawnCall, waitFor } from './test-helpers/fake-controller-child';

const CREDENTIAL = 'swcc_credential-placeholder-value';
const SERVER = 'server-1';
const WORKSPACE = 'workspace-1';
const NOW = Date.parse('2026-01-01T00:00:00Z');

let base: string;
let secrets: Map<string, string>;
let events: EmbeddedControllerStateEvent[];
let calls: SpawnCall[];
let management: { [K in keyof ManagementPort]: Mock<ManagementPort[K]> };
let services: EmbeddedControllerService[];
/** The server's API URL as Console has it now; null for a server it no longer knows. */
let apiUrl: string | null;
/** The Console agents moved onto this computer's controller. */
let moved: string[];

function service(overrides: Partial<EmbeddedControllerDeps> = {}): EmbeddedControllerService {
  const spawned = fakeSpawn();
  calls = spawned.calls;
  const created = new EmbeddedControllerService({
    platform: 'linux',
    machine: () => ({
      name: 'build-box',
      hostname: 'build-box',
      platform: { os: 'linux', arch: 'x64', os_version: '6.1.0' },
    }),
    records: new EnrollmentFile(() => join(base, 'state.json')),
    serverApiUrl: async () => apiUrl,
    secrets: {
      getSecret: async (key) => secrets.get(key) ?? null,
      setSecret: async (key, value) => void secrets.set(key, value),
      deleteSecret: async (key) => void secrets.delete(key),
    },
    management,
    files: {
      dataDir: (serverId) => controllerDataDir(base, serverId),
      turnOffWatchers,
      wipeIdentity: wipeControllerIdentity,
    },
    bundles: {
      controller: () => '/app/dist-sidecar/agent-controller.mjs',
      sharedHost: () => '/app/dist-sidecar/shared-host.mjs',
    },
    controllerVersion: async () => '0.1.0',
    spawn: spawned.spawn,
    execPath: '/app/electron',
    env: () => ({ PATH: '/usr/bin', HOME: '/home/someone' }),
    emit: (event) => events.push(event),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    controllerLine: () => {},
    now: () => NOW,
    backoff: { initialMs: 10, maxMs: 40, stableMs: 10_000 },
    revokeGraceMs: 200,
    stopTimeoutMs: 200,
    movedAgents: async () => moved,
    ...overrides,
  });
  services.push(created);
  return created;
}

function lastPhase(): EmbeddedControllerPhase | undefined {
  return events.filter((event) => event.serverId === SERVER).at(-1)?.phase;
}

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path));
    else found.push(path);
  }
  return found;
}

function serverArg(call: SpawnCall): string | undefined {
  return call.args[call.args.indexOf('--server') + 1];
}

function storedRecord(): unknown {
  return JSON.parse(readFileSync(join(base, 'state.json'), 'utf8')).servers[SERVER];
}

function dataDir(): string {
  return controllerDataDir(base, SERVER);
}

/** A watcher root and a database, as a controller that ran would have left them. */
function leaveControllerState(): void {
  mkdirSync(join(dataDir(), 'watchers', 'agent-1'), { recursive: true });
  writeFileSync(
    join(dataDir(), 'watchers', 'agent-1', 'watch.json'),
    '{"enabled":true,"spawn":true}'
  );
  writeFileSync(join(dataDir(), 'controller.db'), 'sqlite');
  mkdirSync(join(dataDir(), 'agents', 'agent-1'), { recursive: true });
  writeFileSync(join(dataDir(), 'agents', 'agent-1', 'credentials.json'), '{}');
  mkdirSync(join(dataDir(), 'workspaces', 'scout'), { recursive: true });
}

async function enabled(
  overrides: Partial<EmbeddedControllerDeps> = {}
): Promise<EmbeddedControllerService> {
  const created = service(overrides);
  await created.enable(SERVER, WORKSPACE);
  await waitFor(() => calls.length === 1, 'the controller started');
  return created;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'embedded-controller-'));
  secrets = new Map();
  events = [];
  services = [];
  apiUrl = 'https://switch.example.com';
  moved = [];
  management = {
    enroll: vi.fn<ManagementPort['enroll']>(async () => ({
      serverId: SERVER,
      apiUrl: 'https://switch.example.com',
      controllerId: 'controller-1',
      credential: CREDENTIAL,
    })),
    read: vi.fn<ManagementPort['read']>(async () => ({ kind: 'ok', controller: null, agents: [] })),
    update: vi.fn<ManagementPort['update']>(async () => {}),
    revoke: vi.fn<ManagementPort['revoke']>(async () => 'revoked'),
  };
});

afterEach(async () => {
  for (const created of services) await created.dispose();
  rmSync(base, { recursive: true, force: true });
});

describe('EmbeddedControllerService', () => {
  it('enrolls, keeps the credential in the secrets store only, and hands it to the child on stdin', async () => {
    await enabled();
    expect(management.enroll).toHaveBeenCalledWith(WORKSPACE, {
      name: 'build-box',
      platform: { os: 'linux', arch: 'x64', os_version: '6.1.0' },
      version: '0.1.0',
    });
    expect(secrets.get(credentialSecretKey(SERVER))).toBe(CREDENTIAL);

    const call = calls[0]!;
    expect(call.command).toBe('/app/electron');
    expect(call.args).toEqual([
      '/app/dist-sidecar/agent-controller.mjs',
      'run',
      '--data-dir',
      dataDir(),
      '--controller-id',
      'controller-1',
      '--server',
      'https://switch.example.com',
      '--name',
      'build-box',
      '--credential-stdin',
      '--shared-host-bundle',
      '/app/dist-sidecar/shared-host.mjs',
    ]);
    expect(call.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/someone',
      ELECTRON_RUN_AS_NODE: '1',
      SWITCH_CONTROLLER_LOG_LEVEL: 'info',
    });
    await waitFor(() => call.child.stdin.writableEnded, 'stdin closed');
    expect(call.child.received).toBe(CREDENTIAL);

    for (const file of filesUnder(base))
      expect(readFileSync(file, 'utf8').includes(CREDENTIAL), file).toBe(false);
    expect(JSON.parse(readFileSync(join(base, 'state.json'), 'utf8'))).toEqual({
      version: 1,
      servers: {
        [SERVER]: {
          kind: 'enrolled',
          controllerId: 'controller-1',
          server: 'https://switch.example.com',
          name: 'build-box',
          workspaceId: WORKSPACE,
          enrolledAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });
    expect(lastPhase()).toEqual({ kind: 'running', since: '2026-01-01T00:00:00.000Z' });
    expect(events.map((event) => event.phase.kind)).toEqual(['enrolling', 'running']);
  });

  it('enrolls again when Switch no longer lists the machine, forgetting the old identity', async () => {
    const running = await enabled();
    management.enroll.mockResolvedValueOnce({
      serverId: SERVER,
      apiUrl: 'https://switch.example.com',
      controllerId: 'controller-2',
      credential: 'swcc_second',
    });
    await running.enrollAgain(SERVER);
    expect(management.revoke).not.toHaveBeenCalled();
    expect(management.enroll).toHaveBeenCalledTimes(2);
    await waitFor(() => calls.length === 2, 'the new controller started');
    expect(storedRecord()).toMatchObject({ kind: 'enrolled', controllerId: 'controller-2' });
    expect(secrets.get(credentialSecretKey(SERVER))).toBe('swcc_second');
  });

  it('enrolls again when Switch revoked the machine', async () => {
    const running = await enabled();
    management.read.mockResolvedValue({
      kind: 'ok',
      controller: { name: 'build-box', description: null, state: 'revoked', lastSeenAt: null },
      agents: [],
    });
    management.enroll.mockResolvedValueOnce({
      serverId: SERVER,
      apiUrl: 'https://switch.example.com',
      controllerId: 'controller-3',
      credential: 'swcc_third',
    });
    await running.enrollAgain(SERVER);
    expect(storedRecord()).toMatchObject({ kind: 'enrolled', controllerId: 'controller-3' });
  });

  it('refuses to enroll again while Switch still lists the machine', async () => {
    const running = await enabled();
    management.read.mockResolvedValue({
      kind: 'ok',
      controller: { name: 'build-box', description: null, state: 'offline', lastSeenAt: null },
      agents: [],
    });
    await expect(running.enrollAgain(SERVER)).rejects.toThrow(/still lists this computer/);
    expect(management.enroll).toHaveBeenCalledTimes(1);
  });

  it('restarts the controller with backoff when it exits on its own', async () => {
    await enabled();
    calls[0]!.child.exit(1);
    expect(lastPhase()).toMatchObject({ kind: 'restarting', attempt: 1 });
    await waitFor(() => calls.length === 2, 'the restart');
    calls[1]!.child.exit(null, 'SIGSEGV');
    expect(lastPhase()).toEqual({
      kind: 'restarting',
      attempt: 2,
      retryAt: new Date(NOW + 20).toISOString(),
      lastExit: 'signal SIGSEGV',
    });
    await waitFor(() => calls.length === 3, 'the second restart');
    await waitFor(() => calls[2]!.child.received === CREDENTIAL, 'the credential again');
  });

  it('forgets the credential and the identity when Switch removes this computer (exit 3)', async () => {
    const running = await enabled();
    leaveControllerState();
    calls[0]!.child.exit(3);
    await waitFor(() => lastPhase()?.kind === 'removed', 'the removed phase');
    expect(secrets.has(credentialSecretKey(SERVER))).toBe(false);
    expect(readFileSync(join(dataDir(), 'watchers', 'agent-1', 'watch.json'), 'utf8')).toBe(
      '{"enabled":false,"spawn":false}'
    );
    expect(readdirSync(dataDir()).sort()).toEqual(['watchers', 'workspaces']);
    expect(JSON.parse(readFileSync(join(base, 'state.json'), 'utf8')).servers[SERVER]).toEqual({
      kind: 'removed',
      controllerId: 'controller-1',
      at: '2026-01-01T00:00:00.000Z',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(1);
    expect((await running.overview(SERVER, WORKSPACE)).phase).toEqual({
      kind: 'removed',
      at: '2026-01-01T00:00:00.000Z',
    });

    // The notice survives a relaunch, until it is dismissed.
    const relaunched = service();
    await relaunched.initialize();
    expect(calls).toHaveLength(0);
    expect((await relaunched.overview(SERVER, null)).phase.kind).toBe('removed');
    await relaunched.dismiss(SERVER);
    expect((await relaunched.overview(SERVER, null)).phase).toEqual({ kind: 'off' });
  });

  it('does not restart a controller another copy took over (exit 4), until asked to', async () => {
    const running = await enabled();
    calls[0]!.child.exit(4);
    expect(lastPhase()).toEqual({ kind: 'taken_over', at: '2026-01-01T00:00:00.000Z' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(1);
    expect(secrets.get(credentialSecretKey(SERVER))).toBe(CREDENTIAL);
    await running.restart(SERVER);
    await waitFor(() => calls.length === 2, 'the restart asked for');
  });

  it('turns off by revoking on the server, letting the controller exit, and forgetting it', async () => {
    const running = await enabled();
    leaveControllerState();
    management.revoke.mockImplementation(async () => {
      // As the real controller does on the credential.revoked nudge.
      queueMicrotask(() => calls[0]!.child.exit(3));
      return 'revoked' as const;
    });
    await running.disable(SERVER);
    expect(management.revoke).toHaveBeenCalledWith(WORKSPACE, 'controller-1');
    expect(calls[0]!.child.signals).toEqual([]);
    expect(secrets.has(credentialSecretKey(SERVER))).toBe(false);
    expect(JSON.parse(readFileSync(join(base, 'state.json'), 'utf8')).servers).toEqual({});
    expect(readdirSync(dataDir()).sort()).toEqual(['watchers', 'workspaces']);
    expect(readFileSync(join(dataDir(), 'watchers', 'agent-1', 'watch.json'), 'utf8')).toBe(
      '{"enabled":false,"spawn":false}'
    );
    expect(lastPhase()).toEqual({ kind: 'off' });
    expect(events.map((event) => event.phase.kind)).not.toContain('removed');
  });

  it('stops a revoked controller that does not exit by itself, and turns its watchers off', async () => {
    const running = await enabled();
    leaveControllerState();
    await running.disable(SERVER);
    expect(calls[0]!.child.signals).toEqual(['SIGTERM']);
    expect(readFileSync(join(dataDir(), 'watchers', 'agent-1', 'watch.json'), 'utf8')).toBe(
      '{"enabled":false,"spawn":false}'
    );
    expect(lastPhase()).toEqual({ kind: 'off' });
  });

  it('keeps everything running when the server refuses the revoke, and says why', async () => {
    const running = await enabled();
    management.revoke.mockRejectedValue(new Error('Could not remove this computer from Switch'));
    await expect(running.disable(SERVER)).rejects.toThrow(/Could not remove/);
    expect(calls[0]!.child.signals).toEqual([]);
    expect(secrets.get(credentialSecretKey(SERVER))).toBe(CREDENTIAL);
    expect(lastPhase()).toEqual({ kind: 'running', since: '2026-01-01T00:00:00.000Z' });
    expect((await running.overview(SERVER, null)).enrollment?.controllerId).toBe('controller-1');
  });

  it('renames a machine still called by its raw host name to the computer name, once', async () => {
    const machine = () => ({
      name: 'Build Box',
      hostname: 'BX0042',
      platform: { os: 'macos', arch: 'arm64', os_version: '24.0.0' },
    });
    const remote = (name: string) => ({
      kind: 'ok' as const,
      controller: { name, description: null, state: 'online' as const, lastSeenAt: null },
      agents: [],
    });
    const running = await enabled({ machine });
    management.read.mockResolvedValue(remote('BX0042'));
    const renamed = await running.overview(SERVER, null);
    expect(management.update).toHaveBeenCalledWith(WORKSPACE, 'controller-1', {
      name: 'Build Box',
    });
    expect(renamed.remote).toMatchObject({ controller: { name: 'Build Box' } });

    management.update.mockClear();
    management.read.mockResolvedValue(remote('my laptop'));
    await running.overview(SERVER, null);
    expect(management.update).not.toHaveBeenCalled();
  });

  it('says which agents moved from this Console run on it', async () => {
    const running = await enabled();
    moved = ['builder'];
    expect((await running.overview(SERVER, null)).movedAgents).toEqual(['builder']);
  });

  it('refuses to turn off, with nothing changed, while agents moved from this Console run on it', async () => {
    const running = await enabled();
    moved = ['builder'];
    const refused = running.disable(SERVER);
    await expect(refused).rejects.toBeInstanceOf(MovedAgentsHereError);
    await expect(refused).rejects.toThrow(
      'This computer runs builder as managed agents for this Console. Delete those agents before turning it off.'
    );
    expect(management.revoke).not.toHaveBeenCalled();
    expect(calls[0]!.child.signals).toEqual([]);
    expect(secrets.get(credentialSecretKey(SERVER))).toBe(CREDENTIAL);
    expect(lastPhase()).toEqual({ kind: 'running', since: '2026-01-01T00:00:00.000Z' });
  });

  it('revokes a controller it enrolled but could not keep, and keeps nothing', async () => {
    const created = service({
      secrets: {
        getSecret: async () => null,
        setSecret: async () => {
          throw new Error('Secure secret storage is unavailable on this system.');
        },
        deleteSecret: async () => {},
      },
    });
    await expect(created.enable(SERVER, WORKSPACE)).rejects.toThrow(/Secure secret storage/);
    expect(management.revoke).toHaveBeenCalledWith(WORKSPACE, 'controller-1');
    expect(calls).toHaveLength(0);
    expect((await created.overview(SERVER, null)).enrollment).toBeNull();
    expect(lastPhase()).toEqual({ kind: 'off' });
  });

  it('does not enroll when the controller bundle cannot run, or the server lacks management', async () => {
    const broken = service({
      controllerVersion: async () => {
        throw new Error('agent-controller.mjs not found');
      },
    });
    await expect(broken.enable(SERVER, WORKSPACE)).rejects.toThrow(/not found/);
    expect(management.enroll).not.toHaveBeenCalled();

    management.enroll.mockRejectedValue(
      new Error('Switch does not have agent management turned on.')
    );
    await expect(service().enable(SERVER, WORKSPACE)).rejects.toThrow(/agent management/);
    expect(secrets.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('refuses on Windows, where the controller cannot run', async () => {
    const windows = service({ platform: 'win32' });
    await expect(windows.enable(SERVER, WORKSPACE)).rejects.toThrow(WINDOWS_UNSUPPORTED);
    expect((await windows.overview(SERVER, WORKSPACE)).unsupportedReason).toBe(WINDOWS_UNSUPPORTED);
    expect(management.enroll).not.toHaveBeenCalled();
  });

  it('starts the enrolled controllers at launch, and reports a credential it cannot find', async () => {
    await enabled();
    const relaunched = service();
    await relaunched.initialize();
    await waitFor(() => calls.length === 1, 'the controller started at launch');
    await waitFor(() => calls[0]!.child.received === CREDENTIAL, 'the credential handed over');

    secrets.clear();
    const without = service();
    await without.initialize();
    await waitFor(() => lastPhase()?.kind === 'error', 'the error');
    expect(lastPhase()).toEqual({
      kind: 'error',
      message:
        'The credential for this computer is missing. Turn it off and on again to enroll afresh.',
    });
    expect(calls).toHaveLength(0);
  });

  it('stops its controllers at quit with SIGTERM and does not start them again', async () => {
    const running = await enabled();
    await running.dispose();
    expect(calls[0]!.child.signals).toEqual(['SIGTERM']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(1);
  });

  it('asks the server about the enrolled workspace, or the one given when not enrolled', async () => {
    const created = service();
    await created.overview(SERVER, 'workspace-in-scope');
    expect(management.read).toHaveBeenLastCalledWith('workspace-in-scope', null);
    expect((await created.overview(SERVER, null)).remote).toBeNull();
    await created.enable(SERVER, WORKSPACE);
    await created.overview(SERVER, 'workspace-in-scope');
    expect(management.read).toHaveBeenLastCalledWith(WORKSPACE, 'controller-1');
  });

  it('renames and describes this computer on the server, through the enrolled workspace', async () => {
    const svc = await enabled();
    await svc.updateDetails(SERVER, { name: '  laptop ', description: '  My laptop ' });
    await svc.updateDetails(SERVER, { description: '   ' });
    expect(management.update.mock.calls).toEqual([
      [WORKSPACE, 'controller-1', { name: 'laptop', description: 'My laptop' }],
      [WORKSPACE, 'controller-1', { description: null }],
    ]);
    await expect(svc.updateDetails(SERVER, { name: '  ' })).rejects.toThrow(
      'A machine needs a name.'
    );
    expect(management.update).toHaveBeenCalledTimes(2);
  });

  it('refuses to change a computer that is not enrolled', async () => {
    await expect(service().updateDetails(SERVER, { name: 'laptop' })).rejects.toThrow(
      /not enrolled/
    );
    expect(management.update).not.toHaveBeenCalled();
  });

  it('forgets a server being removed even when the revoke fails', async () => {
    const running = await enabled();
    management.revoke.mockRejectedValue(new Error('Not signed in to this Switch server.'));
    await running.forgetServer(SERVER);
    expect(calls[0]!.child.signals).toEqual(['SIGTERM']);
    expect(secrets.size).toBe(0);
    expect((await running.overview(SERVER, null)).enrollment).toBeNull();
  });
  it('restarts a running controller at the server’s new API URL', async () => {
    const running = await enabled();
    apiUrl = 'https://moved.example.com';
    await running.followServerApiUrl(SERVER);
    expect(calls[0]!.child.signals).toEqual(['SIGTERM']);
    await waitFor(() => calls.length === 2, 'the restart at the new URL');
    expect(serverArg(calls[1]!)).toBe('https://moved.example.com');
    await waitFor(() => calls[1]!.child.received === CREDENTIAL, 'the credential again');
    expect(storedRecord()).toMatchObject({
      kind: 'enrolled',
      controllerId: 'controller-1',
      server: 'https://moved.example.com',
    });
    expect(lastPhase()).toEqual({ kind: 'running', since: '2026-01-01T00:00:00.000Z' });
  });

  it('takes the new API URL when it next starts, if it was not running', async () => {
    const running = await enabled();
    calls[0]!.child.exit(4);
    apiUrl = 'https://moved.example.com';
    await running.followServerApiUrl(SERVER);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toHaveLength(1);
    expect(lastPhase()?.kind).toBe('taken_over');
    await running.restart(SERVER);
    await waitFor(() => calls.length === 2, 'the restart asked for');
    expect(serverArg(calls[1]!)).toBe('https://moved.example.com');
  });

  it('follows a URL that changed while Console was closed, at launch', async () => {
    const first = await enabled();
    await first.dispose();
    apiUrl = 'http://127.0.0.1:18000';
    const relaunched = service();
    await relaunched.initialize();
    await waitFor(() => calls.length === 1, 'the controller started at launch');
    expect(serverArg(calls[0]!)).toBe('http://127.0.0.1:18000');
    expect(storedRecord()).toMatchObject({ server: 'http://127.0.0.1:18000' });
  });

  it('does not restart a controller whose API URL is unchanged by an edit elsewhere', async () => {
    const running = await enabled();
    const before = calls.length;
    await running.followServerApiUrl('another-server');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toHaveLength(before);
    expect(calls[0]!.child.signals).toEqual([]);
  });

  it('reports a server Console no longer knows instead of starting at a stale URL', async () => {
    await enabled();
    apiUrl = null;
    const relaunched = service();
    await relaunched.initialize();
    await waitFor(() => lastPhase()?.kind === 'error', 'the error');
    expect(lastPhase()).toEqual({
      kind: 'error',
      message: 'Console no longer knows this Switch server, so it cannot say where to connect.',
    });
    expect(calls).toHaveLength(0);
  });
});
