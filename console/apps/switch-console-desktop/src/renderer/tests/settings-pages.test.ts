import { describe, expect, it } from 'vitest';
import {
  describeCreatedKeyExpiry,
  formatKeyExpiry,
  keyLifetime,
  splitApiKeys,
} from '@renderer/features/settings/pages/api-keys';
import {
  resolveSettingsTab,
  type SettingsAudience,
  settingsSections,
  shownSettingsTab,
} from '@renderer/features/settings/settings-tabs';
import { parseConsoleLink } from '@shared/core/deeplinks/console-links';
import { settingsPagePath } from '@shared/core/switch-servers/dashboard-pages';
import { type SwitchApiKey } from '@shared/core/switch-servers/switch-servers';

const everyone: SettingsAudience = {
  hasServer: true,
  agentManagement: true,
  workspaceSettings: true,
  organizationSettings: false,
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
        'remote-hosts',
        'managed-agents',
        'status',
      ],
      ['account'],
      ['workspace-settings', 'docs'],
    ]);
  });

  it('keeps only what stands without a server when there is none', () => {
    expect(
      ids({
        hasServer: false,
        agentManagement: false,
        workspaceSettings: false,
        organizationSettings: false,
      })
    ).toEqual([['preferences', 'clis-models', 'remote-hosts', 'status'], [], ['docs']]);
  });

  it('offers workspace settings only where a gateway serves them', () => {
    expect(ids({ ...everyone, workspaceSettings: false })[2]).toEqual(['docs']);
  });

  it("offers the organization's settings to its admins, after the workspace's", () => {
    expect(ids({ ...everyone, organizationSettings: true })[2]).toEqual([
      'workspace-settings',
      'organization-settings',
      'docs',
    ]);
    expect(ids(everyone)[2]).not.toContain('organization-settings');
  });

  it('opens the settings of the gateway layout the server has on', () => {
    expect(settingsPagePath('workspace-settings', false)).toBe('workspace');
    expect(settingsPagePath('organization-settings', false)).toBe('organization');
    expect(settingsPagePath('workspace-settings', true)).toBe('settings');
    expect(settingsPagePath('organization-settings', true)).toBe('settings/org');
  });

  it('offers your devices and managed agents only with agent management', () => {
    const main = ids({ ...everyone, agentManagement: false })[0];
    expect(main).not.toContain('managed-agents');
    expect(main).not.toContain('devices');
    expect(main).toContain('remote-hosts');
  });

  it('falls back to Preferences for a tab the sidebar does not offer', () => {
    const noServer = settingsSections({
      hasServer: false,
      agentManagement: false,
      workspaceSettings: false,
      organizationSettings: false,
    });
    expect(shownSettingsTab('account', noServer)).toBe('preferences');
    expect(shownSettingsTab('remote-hosts', noServer)).toBe('remote-hosts');
    expect(shownSettingsTab('devices', noServer)).toBe('preferences');
  });

  it('sends the tabs Settings used to have where they went', () => {
    expect(resolveSettingsTab('general')).toBe('preferences');
    expect(resolveSettingsTab('interface')).toBe('preferences');
    expect(resolveSettingsTab('remote-hosts')).toBe('remote-hosts');
    expect(resolveSettingsTab('api-keys')).toBe('api-keys');
    expect(resolveSettingsTab('nonsense')).toBe('preferences');
    expect(resolveSettingsTab(undefined)).toBe('preferences');
  });

  it("still opens an older switch-buddy's links to retired tabs", () => {
    for (const tab of ['general', 'interface', 'remote-hosts', 'devices', 'account']) {
      expect(parseConsoleLink(`switchdash://open/settings?tab=${tab}`)).toMatchObject({ ok: true });
    }
    expect(parseConsoleLink('switchdash://open/settings?tab=browser')).toMatchObject({ ok: false });
  });
});

const key = (id: string, type: string): SwitchApiKey => ({
  id,
  label: id,
  type,
  keyPrefix: 'abc',
  createdAt: '2026-11-03',
  expiresAt: null,
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

  it("shows a key's expiry, past expiry, or that it has none", () => {
    const now = new Date('2026-11-06T12:00:00Z');
    expect(formatKeyExpiry(null, now)).toBe('No expiry');
    expect(formatKeyExpiry('2027-02-04T12:00:00Z', now)).toBe('2027-02-04');
    expect(formatKeyExpiry('2026-11-01T12:00:00Z', now)).toBe('Expired 2026-11-01');
  });

  it("describes a new key's expiry", () => {
    expect(describeCreatedKeyExpiry(null)).toBe('This key does not expire.');
    expect(describeCreatedKeyExpiry('2027-02-04T12:00:00Z')).toBe('Expires 2027-02-04.');
  });

  it('sends the chosen lifetime as days or never', () => {
    expect(keyLifetime('90')).toBe(90);
    expect(keyLifetime('365')).toBe(365);
    expect(keyLifetime('never')).toBe('never');
  });
});
