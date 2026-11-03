import { describe, expect, it } from 'vitest';
import {
  deviceAgents,
  enrollCommands,
  formatBytes,
  osName,
  platformLabel,
  shellQuote,
} from '@renderer/features/devices/device-model';
import { moveTargets } from '@renderer/features/managed-agents/move-targets';
import type {
  DeviceReport,
  ManagedAgentView,
  MachineProvider,
  OwnedMachine,
} from '@shared/core/managed-agents/managed-agents';

const NO_REPORT: DeviceReport = {
  createdAt: null,
  version: null,
  release: null,
  platform: null,
  machine: null,
  observedAt: null,
  agents: [],
};

function agent(patch: Partial<ManagedAgentView> & { agentId: string }): ManagedAgentView {
  return {
    serverId: 'server-1',
    workspaceId: 'workspace-1',
    name: patch.agentId,
    displayName: null,
    iconUrl: null,
    description: '',
    machine: { id: 'here', name: 'laptop', kind: 'console', state: 'online' },
    desiredState: 'running',
    revision: 1,
    definition: {
      provider: 'claude',
      model: null,
      advancedConfig: {},
      instructions: '',
      autoMode: false,
      autoApprove: false,
      directory: null,
      isolation: 'shared',
    },
    status: null,
    ...patch,
  };
}

function machine(patch: Partial<OwnedMachine> & { id: string }): OwnedMachine {
  return {
    name: patch.id,
    kind: 'daemon',
    state: 'online',
    providers: [],
    acceptsLogins: false,
    cloud: false,
    workspacesDir: null,
    os: null,
    local: null,
    ...patch,
  };
}

const ready = (provider: string): MachineProvider => ({
  provider,
  ready: true,
  problem: null,
  detail: null,
  loginHelps: true,
});

describe('deviceAgents', () => {
  it('lists only the agents placed on the device, by name, with its report on each', () => {
    const report = {
      agentId: 'b',
      process: 'running',
      attached: true,
      activeSessions: 2,
      restarts10m: 0,
      since: null,
      reason: null,
      detail: null,
    };
    const rows = deviceAgents({ id: 'here', report: { ...NO_REPORT, agents: [report] } }, [
      agent({ agentId: 'b', displayName: 'Zed' }),
      agent({ agentId: 'a' }),
      agent({
        agentId: 'elsewhere',
        machine: { id: 'there', name: 'x', kind: 'daemon', state: 'online' },
      }),
      agent({ agentId: 'nowhere', machine: null }),
    ]);
    expect(rows.map((row) => [row.agent.agentId, row.report])).toEqual([
      ['a', null],
      ['b', report],
    ]);
  });
});

describe('moveTargets', () => {
  it('offers every other device, this computer first, and blocks those Switch would refuse', () => {
    const targets = moveTargets(agent({ agentId: 'a' }), [
      machine({ id: 'here', name: 'laptop', providers: [ready('claude')] }),
      machine({ id: 'zz', name: 'zz-box', providers: [ready('claude')] }),
      machine({ id: 'off', name: 'off-box', state: 'offline' }),
      machine({ id: 'nocli', name: 'codex-box', providers: [ready('codex')] }),
      machine({
        id: 'expired',
        name: 'expired-box',
        providers: [{ ...ready('claude'), ready: false, problem: 'login expired' }],
      }),
      machine({ id: 'new', name: 'new-box' }),
      machine({
        id: 'me',
        name: 'mac',
        local: { kind: 'this-computer' },
        providers: [ready('claude')],
      }),
      machine({
        id: 'cloud',
        name: 'ec2-1',
        kind: 'ec2',
        cloud: true,
        providers: [ready('claude')],
      }),
      machine({ id: 'gone', name: 'gone', state: 'revoked' }),
    ]);
    expect(targets).toEqual([
      { machineId: 'me', label: 'This computer', blocked: null },
      { machineId: 'nocli', label: 'codex-box', blocked: 'Claude Code not installed' },
      { machineId: 'cloud', label: 'Switch cloud', blocked: null },
      { machineId: 'expired', label: 'expired-box', blocked: 'Claude Code login expired' },
      { machineId: 'new', label: 'new-box', blocked: null },
      { machineId: 'off', label: 'off-box', blocked: 'offline' },
      { machineId: 'zz', label: 'zz-box', blocked: null },
    ]);
  });
});

describe('enrollCommands', () => {
  it('gives the install one-liner and the enroll command, quoting what the shell would split', () => {
    const commands = enrollCommands({
      serverUrl: 'https://switch.example.com',
      code: 'swe_abc',
      name: " Ada's box ",
      description: '',
    });
    expect(commands.install).toBe(
      "curl -fsSL https://raw.githubusercontent.com/sandbox-quantum/switch/main/console/packages/agent-controller/install.sh | sh -s -- --server https://switch.example.com --code swe_abc --name 'Ada'\\''s box'"
    );
    expect(commands.enroll).toBe(
      "switch-agent-controller enroll --server https://switch.example.com --code swe_abc --name 'Ada'\\''s box' && switch-agent-controller install-service"
    );
  });

  it('leaves a blank name out, so the controller names itself after its host', () => {
    expect(
      enrollCommands({ serverUrl: 'https://s.example', code: 'c', name: '  ', description: 'x y' })
        .enroll
    ).toBe(
      "switch-agent-controller enroll --server https://s.example --code c --description 'x y' && switch-agent-controller install-service"
    );
  });

  it('quotes only what needs it', () => {
    expect(shellQuote('build-01.example:22')).toBe('build-01.example:22');
    expect(shellQuote('$(rm -rf ~)')).toBe("'$(rm -rf ~)'");
  });
});

describe('device facts', () => {
  it('names the platform with its version and architecture when known', () => {
    expect(platformLabel({ os: 'macos', arch: 'arm64', osVersion: '15.1' })).toBe(
      'macOS 15.1 (arm64)'
    );
    expect(platformLabel({ os: 'freebsd', arch: null, osVersion: null })).toBe('freebsd');
    expect(platformLabel(null)).toBeNull();
    expect([osName('darwin'), osName('macos'), osName('win32'), osName('plan9')]).toEqual([
      'macOS',
      'macOS',
      'Windows',
      'plan9',
    ]);
  });

  it('formats byte counts in binary units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(7.5 * 1024 ** 3)).toBe('7.5 GB');
    expect(formatBytes(500 * 1024 ** 3)).toBe('500 GB');
  });
});
