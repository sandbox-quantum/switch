import { describe, expect, it } from 'vitest';
import { splitApiKeys } from '@renderer/features/settings/pages/api-keys';
import { deviceRows } from '@renderer/features/settings/pages/devices';
import {
  resolveSettingsTab,
  type SettingsAudience,
  settingsSections,
  shownSettingsTab,
} from '@renderer/features/settings/settings-tabs';
import { parseConsoleLink } from '@shared/core/deeplinks/console-links';
import { type OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import { type SwitchApiKey } from '@shared/core/switch-servers/switch-servers';

const everyone: SettingsAudience = {
  hasServer: true,
  agentManagement: true,
  workspaceSettings: true,
};

const ids = (audience: SettingsAudience) =>
  settingsSections(audience).map((items) => items.map((item) => item.id));

describe('Settings sections', () => {
  it('lists the design order: your things, then your account, then the ways out', () => {
    expect(ids(everyone)).toEqual([
      [
        'preferences',
        'messaging-apps',
        'clis-models',
        'api-keys',
        'devices',
        'managed-agents',
        'status',
      ],
      ['account'],
      ['workspace-settings', 'docs'],
    ]);
  });

  it('keeps only what stands without a server when there is none', () => {
    expect(ids({ hasServer: false, agentManagement: false, workspaceSettings: false })).toEqual([
      ['preferences', 'clis-models', 'devices', 'status'],
      [],
      ['docs'],
    ]);
  });

  it('offers workspace settings only where a gateway serves them', () => {
    expect(ids({ ...everyone, workspaceSettings: false })[2]).toEqual(['docs']);
  });

  it('offers managed agents only with agent management', () => {
    expect(ids({ ...everyone, agentManagement: false })[0]).not.toContain('managed-agents');
  });

  it('falls back to Preferences for a tab the sidebar does not offer', () => {
    const noServer = settingsSections({
      hasServer: false,
      agentManagement: false,
      workspaceSettings: false,
    });
    expect(shownSettingsTab('account', noServer)).toBe('preferences');
    expect(shownSettingsTab('devices', noServer)).toBe('devices');
  });

  it('sends the tabs Settings used to have where they went', () => {
    expect(resolveSettingsTab('general')).toBe('preferences');
    expect(resolveSettingsTab('interface')).toBe('preferences');
    expect(resolveSettingsTab('remote-hosts')).toBe('devices');
    expect(resolveSettingsTab('api-keys')).toBe('api-keys');
    expect(resolveSettingsTab('nonsense')).toBe('preferences');
    expect(resolveSettingsTab(undefined)).toBe('preferences');
  });

  it("still opens an older switch-buddy's links to retired tabs", () => {
    for (const tab of ['general', 'interface', 'remote-hosts', 'account']) {
      expect(parseConsoleLink(`switchdash://open/settings?tab=${tab}`)).toMatchObject({ ok: true });
    }
    expect(parseConsoleLink('switchdash://open/settings?tab=browser')).toMatchObject({ ok: false });
  });
});

const machine = (overrides: Partial<OwnedMachine>): OwnedMachine => ({
  id: 'm',
  name: 'machine',
  kind: 'desktop',
  state: 'online',
  providers: [],
  acceptsLogins: true,
  cloud: false,
  workspacesDir: null,
  os: 'linux',
  local: null,
  ...overrides,
});

describe('Your devices', () => {
  it('puts this computer first, counts agents, and leaves out revoked machines', () => {
    const rows = deviceRows(
      [
        machine({ id: 'b', name: 'build-01', local: { kind: 'ssh-host', sshHost: 'build-01' } }),
        machine({ id: 'c', name: 'ec2', kind: 'ec2', cloud: true }),
        machine({ id: 'here', name: 'laptop', os: 'macos', local: { kind: 'this-computer' } }),
        machine({ id: 'gone', name: 'old', state: 'revoked' }),
      ],
      [
        { machine: { id: 'here' } },
        { machine: { id: 'here' } },
        { machine: { id: 'b' } },
        { machine: null },
      ]
    );
    expect(rows.map((row) => [row.name, row.detail, row.type, row.agents, row.platform])).toEqual([
      ['laptop', 'This computer', 'computer', 2, 'macOS'],
      ['build-01', 'build-01', 'ssh', 1, 'Linux'],
      ['Switch cloud', null, 'cloud', 0, 'Linux'],
    ]);
  });
});

const key = (id: string, type: string): SwitchApiKey => ({
  id,
  label: id,
  type,
  keyPrefix: 'abc',
  createdAt: '2026-11-03',
});

describe('API keys', () => {
  it('splits registration keys from agent keys and drops anything else', () => {
    const split = splitApiKeys([
      key('r', 'registration'),
      key('b', 'bootstrap'),
      key('a', 'agent'),
      key('x', 'other'),
    ]);
    expect(split.registration.map((k) => k.id)).toEqual(['r', 'b']);
    expect(split.agent.map((k) => k.id)).toEqual(['a']);
  });
});
