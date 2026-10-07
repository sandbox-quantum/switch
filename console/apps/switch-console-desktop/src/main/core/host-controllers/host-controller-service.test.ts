import { beforeEach, describe, expect, it } from 'vitest';
import { MovedAgentsHereError } from '@shared/core/agent-migration/agent-migration';
import type { HostControllerStateEvent } from '@shared/core/host-controllers/host-controllers';
import {
  type HostControllerDeps,
  type HostControllerRecord,
  HostControllerService,
  type HostShell,
  serverUrlProblem,
} from './host-controller-service';
import {
  ENROLL_SCRIPT,
  PREPARE_SCRIPT,
  START_SCRIPT,
  STATUS_SCRIPT,
  STOP_SCRIPT,
} from './host-scripts';

const HOST = 'build-box';
const SERVER = 'server-1';
const WORKSPACE = 'workspace-1';
const HASH = 'a'.repeat(64);

type Host = {
  node: string;
  present: boolean;
  systemd: boolean;
  enroll: { ok: true; controllerId: string | null } | { ok: false; reason: string };
  failStart: boolean;
  running: boolean;
  unreachable: boolean;
};

let host: Host;
let calls: string[];
let options: Record<string, Record<string, unknown>>;
let records: Map<string, HostControllerRecord>;
let events: HostControllerStateEvent[];
let revokeOutcome: 'revoked' | 'already_gone' | Error;
let moved: string[];
let serverUrl: string | null;

function fakeShell(): HostShell {
  return {
    script: async (script, args) => {
      const parsed = args[0]?.startsWith('{') ? JSON.parse(args[0]) : {};
      const name =
        script === PREPARE_SCRIPT
          ? 'prepare'
          : script === ENROLL_SCRIPT
            ? 'enroll'
            : script === START_SCRIPT
              ? 'start'
              : script === STATUS_SCRIPT
                ? 'status'
                : script === STOP_SCRIPT
                  ? 'stop'
                  : script.includes('renameSync')
                    ? 'rename'
                    : 'unknown';
      calls.push(name);
      options[name] = parsed;
      switch (name) {
        case 'prepare':
          return JSON.stringify({
            node: host.node,
            execPath: '/usr/bin/node',
            path: '/home/ada/.local/bin:/usr/bin',
            hostname: 'build-box.internal',
            home: '/home/ada',
            directory: '/home/ada/.local/state/switch/sdk-host',
            present: host.present,
            systemd: host.systemd,
          });
        case 'enroll':
          return JSON.stringify(host.enroll);
        case 'start':
          if (host.failStart) throw new Error('systemctl failed');
          host.running = true;
          return JSON.stringify({ pid: 4242 });
        case 'status':
          return JSON.stringify({
            running: host.running,
            state: host.running ? 'running' : 'exited',
            code: host.running ? null : 1,
            log: host.running ? '' : 'last words',
          });
        case 'stop':
          host.running = false;
          return JSON.stringify({ turnedOff: 1 });
        default:
          return '';
      }
    },
    upload: async (_local, remote) => {
      calls.push(`upload ${remote.replace(/\.[0-9a-f-]+\.tmp$/, '.tmp')}`);
    },
    close: () => {},
  };
}

function deps(): HostControllerDeps {
  return {
    shell: async () => {
      if (host.unreachable) throw new Error(`${HOST} is unreachable`);
      return fakeShell();
    },
    records: {
      all: async () => [...records.values()],
      get: async (sshHost, serverId) => records.get(`${sshHost}|${serverId}`) ?? null,
      set: async (record) => {
        calls.push('record');
        records.set(`${record.sshHost}|${record.serverId}`, record);
      },
      delete: async (sshHost, serverId) => {
        calls.push('forget');
        records.delete(`${sshHost}|${serverId}`);
      },
    },
    management: {
      enrollmentCode: async () => {
        calls.push('code');
        return 'swce_one-time';
      },
      serverApiUrl: async () => serverUrl,
      read: async () => ({
        kind: 'ok',
        controller: { state: 'online', lastSeenAt: null },
        agents: [],
      }),
      revoke: async () => {
        calls.push('revoke');
        if (revokeOutcome instanceof Error) throw revokeOutcome;
        return revokeOutcome;
      },
    },
    bundles: {
      controller: async () => ({ path: '/app/dist-sidecar/agent-controller.mjs', hash: HASH }),
      sharedHost: async () => '/home/ada/.local/state/switch/sdk-host/shared-host-b.mjs',
    },
    movedAgents: async () => moved,
    emit: (event) => events.push(event),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    now: () => Date.parse('2026-10-01T00:00:00Z'),
  };
}

beforeEach(() => {
  host = {
    node: '22.14.0',
    present: false,
    systemd: true,
    enroll: { ok: true, controllerId: 'controller-7' },
    failStart: false,
    running: false,
    unreachable: false,
  };
  calls = [];
  options = {};
  records = new Map();
  events = [];
  revokeOutcome = 'revoked';
  moved = [];
  serverUrl = 'https://switch.example.com';
});

describe('making an SSH host a machine', () => {
  it('copies the controller, enrolls it with a one-time code and runs it under systemd', async () => {
    await new HostControllerService(deps()).enable(HOST, SERVER, WORKSPACE);
    expect(calls).toEqual([
      'prepare',
      `upload /home/ada/.local/state/switch/sdk-host/agent-controller-${HASH}.mjs.tmp`,
      'rename',
      'code',
      'enroll',
      'record',
      'start',
    ]);
    expect(options.enroll).toEqual({
      node: '/usr/bin/node',
      bundle: `/home/ada/.local/state/switch/sdk-host/agent-controller-${HASH}.mjs`,
      server: 'https://switch.example.com',
      code: 'swce_one-time',
      name: 'build-box.internal',
      dataDir: `~/.local/state/switch/agent-controller/console-${SERVER}`,
    });
    expect(options.start).toMatchObject({
      supervision: 'systemd',
      unit: `switch-agent-controller-${SERVER}.service`,
    });
    const unit = String(options.start!.unitText);
    expect(unit).toContain(`"/home/ada/.local/state/switch/agent-controller/console-${SERVER}"`);
    expect(unit).toContain('--shared-host-bundle');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartPreventExitStatus=2 3 4');
    expect(unit).toContain('"PATH=/home/ada/.local/bin:/usr/bin"');
    expect(records.get(`${HOST}|${SERVER}`)).toMatchObject({
      controllerId: 'controller-7',
      supervision: 'systemd',
      sharedHost: '/home/ada/.local/state/switch/sdk-host/shared-host-b.mjs',
    });
    expect(events.length).toBeGreaterThan(0);
  });

  it('runs it detached where systemd cannot outlive the SSH session', async () => {
    host.systemd = false;
    host.present = true;
    await new HostControllerService(deps()).enable(HOST, SERVER, WORKSPACE);
    expect(calls).not.toContain('rename');
    expect(options.start).toMatchObject({ supervision: 'detached' });
    expect(options.start!.args).toMatchObject({
      node: '/usr/bin/node',
      dataDir: `~/.local/state/switch/agent-controller/console-${SERVER}`,
    });
    expect(records.get(`${HOST}|${SERVER}`)!.supervision).toBe('detached');
  });

  it('refuses a host whose Node cannot run the controller, before anything is installed', async () => {
    host.node = '20.18.0';
    await expect(new HostControllerService(deps()).enable(HOST, SERVER, WORKSPACE)).rejects.toThrow(
      /Node 20\.18\.0.*22\.13/
    );
    expect(calls).toEqual(['prepare']);
  });

  it('refuses a server the controller would not connect to', async () => {
    serverUrl = 'http://10.0.0.5:8100';
    await expect(new HostControllerService(deps()).enable(HOST, SERVER, WORKSPACE)).rejects.toThrow(
      /https/
    );
    expect(calls).toEqual([]);
  });

  it('keeps nothing when enrolling fails', async () => {
    host.enroll = { ok: false, reason: 'enrollment code is invalid or expired' };
    const service = new HostControllerService(deps());
    await expect(service.enable(HOST, SERVER, WORKSPACE)).rejects.toThrow(/expired/);
    expect(records.size).toBe(0);
    expect(calls).not.toContain('revoke');
    const overview = await service.overview(HOST, SERVER, WORKSPACE);
    expect(overview.phase).toMatchObject({ kind: 'error' });
  });

  it('revokes and cleans up a controller that enrolled but could not start', async () => {
    host.failStart = true;
    await expect(new HostControllerService(deps()).enable(HOST, SERVER, WORKSPACE)).rejects.toThrow(
      'systemctl failed'
    );
    expect(calls.slice(-4)).toEqual(['start', 'revoke', 'stop', 'forget']);
    expect(options.stop).toMatchObject({ turnOff: true, wipe: true });
    expect(records.size).toBe(0);
  });

  it('refuses a host already set up for the server', async () => {
    const service = new HostControllerService(deps());
    await service.enable(HOST, SERVER, WORKSPACE);
    await expect(service.enable(HOST, SERVER, WORKSPACE)).rejects.toThrow(/already runs/);
  });
});

describe('the host as a machine afterwards', () => {
  it('reports the controller running, and the server’s view of it', async () => {
    const service = new HostControllerService(deps());
    await service.enable(HOST, SERVER, WORKSPACE);
    const overview = await service.overview(HOST, SERVER, WORKSPACE);
    expect(overview).toMatchObject({
      enrollment: { controllerId: 'controller-7', supervision: 'systemd' },
      process: { kind: 'running' },
      remote: { kind: 'ok', controller: { state: 'online' } },
      phase: { kind: 'off' },
    });
  });

  it('says it cannot tell when the host cannot be reached', async () => {
    const service = new HostControllerService(deps());
    await service.enable(HOST, SERVER, WORKSPACE);
    host.unreachable = true;
    expect((await service.overview(HOST, SERVER, WORKSPACE)).process).toEqual({
      kind: 'unknown',
      reason: `${HOST} is unreachable`,
    });
  });

  it('keeps a failed start again on the card only while the controller is not running', async () => {
    const service = new HostControllerService(deps());
    await service.enable(HOST, SERVER, WORKSPACE);
    host.node = '20.11.0';
    host.running = false;
    await expect(service.restart(HOST, SERVER)).rejects.toThrow(/Node 20.11.0/);
    expect((await service.overview(HOST, SERVER, WORKSPACE)).phase).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('Node 20.11.0'),
    });
    host.running = true;
    expect((await service.overview(HOST, SERVER, WORKSPACE)).phase).toEqual({ kind: 'off' });
    host.running = false;
    expect((await service.overview(HOST, SERVER, WORKSPACE)).phase).toEqual({ kind: 'off' });
  });

  it('starts it again without turning its agents off', async () => {
    const service = new HostControllerService(deps());
    await service.enable(HOST, SERVER, WORKSPACE);
    calls = [];
    host.present = true;
    await service.restart(HOST, SERVER);
    expect(calls).toEqual(['prepare', 'stop', 'record', 'start']);
    expect(options.stop).toMatchObject({ turnOff: false, wipe: false });
  });
});

describe('enrolling a host again that Switch no longer knows', () => {
  it('wipes the old controller on the host, without a revoke, and enrolls it afresh', async () => {
    const base = deps();
    const service = new HostControllerService({
      ...base,
      management: {
        ...base.management,
        read: async () => ({ kind: 'ok', controller: null, agents: [] }),
      },
    });
    await service.enable(HOST, SERVER, WORKSPACE);
    calls = [];
    host.enroll = { ok: true, controllerId: 'controller-8' };
    await service.enrollAgain(HOST, SERVER);
    expect(calls.slice(0, 2)).toEqual(['stop', 'forget']);
    expect(calls).not.toContain('revoke');
    expect(calls).toContain('code');
    expect(records.get(`${HOST}|${SERVER}`)?.controllerId).toBe('controller-8');
  });

  it('refuses while Switch still lists the host', async () => {
    const service = new HostControllerService(deps());
    await service.enable(HOST, SERVER, WORKSPACE);
    calls = [];
    await expect(service.enrollAgain(HOST, SERVER)).rejects.toThrow(/still lists build/);
    expect(calls).toEqual([]);
  });
});

describe('removing the host as a machine', () => {
  it('revokes the controller first, then stops it and clears it from the host', async () => {
    const service = new HostControllerService(deps());
    await service.enable(HOST, SERVER, WORKSPACE);
    calls = [];
    await service.disable(HOST, SERVER, { force: false });
    expect(calls).toEqual(['revoke', 'stop', 'forget']);
    expect(options.stop).toMatchObject({ turnOff: true, wipe: true });
    expect(records.size).toBe(0);
  });

  it('changes nothing when Switch refuses the revoke', async () => {
    const service = new HostControllerService(deps());
    await service.enable(HOST, SERVER, WORKSPACE);
    calls = [];
    revokeOutcome = new Error('Switch is down');
    await expect(service.disable(HOST, SERVER, { force: false })).rejects.toThrow('Switch is down');
    expect(calls).toEqual(['revoke']);
    expect(records.size).toBe(1);
  });

  it('refuses while agents moved from this Console run there', async () => {
    const service = new HostControllerService(deps());
    await service.enable(HOST, SERVER, WORKSPACE);
    calls = [];
    moved = ['builder'];
    const refused = service.disable(HOST, SERVER, { force: false });
    await expect(refused).rejects.toBeInstanceOf(MovedAgentsHereError);
    await expect(refused).rejects.toThrow(/builder .*before turning it off/);
    expect(calls).toEqual([]);
    expect((await service.overview(HOST, SERVER, WORKSPACE)).phase).toEqual({ kind: 'off' });
  });

  it('refuses to remove the host, with nothing changed, while agents moved from this Console run there', async () => {
    const service = new HostControllerService(deps());
    await service.enable(HOST, SERVER, WORKSPACE);
    calls = [];
    moved = ['builder'];
    const refused = service.forgetHost(HOST);
    await expect(refused).rejects.toBeInstanceOf(MovedAgentsHereError);
    await expect(refused).rejects.toThrow(
      'build-box runs builder for this Console, so it cannot be removed yet. Bring the agents back first'
    );
    await expect(refused).rejects.toMatchObject({ agents: ['builder'] });
    expect(calls).toEqual([]);
    expect(records.size).toBe(1);
  });

  it('forgets a host that cannot be reached once its controller is revoked, when the host is removed', async () => {
    const service = new HostControllerService(deps());
    await service.enable(HOST, SERVER, WORKSPACE);
    calls = [];
    host.unreachable = true;
    await service.forgetHost(HOST);
    expect(calls).toEqual(['revoke', 'forget']);
    expect(records.size).toBe(0);
  });

  it('keeps the record of an unreachable host on a plain turn-off, to be cleaned up later', async () => {
    const service = new HostControllerService(deps());
    await service.enable(HOST, SERVER, WORKSPACE);
    host.unreachable = true;
    await expect(service.disable(HOST, SERVER, { force: false })).rejects.toThrow(
      /removed from Switch, but could not be cleaned up/
    );
    expect(records.size).toBe(1);
  });
});

describe('the server address the controller is given', () => {
  it.each([
    ['https://switch.example.com', null],
    ['http://127.0.0.1:8100', null],
    ['http://localhost:8100', null],
    ['http://10.0.0.5:8100', /https/],
    ['not a url', /not a URL/],
  ])('%s', (url, problem) => {
    if (problem === null) expect(serverUrlProblem(url)).toBeNull();
    else expect(serverUrlProblem(url)).toMatch(problem);
  });
});
