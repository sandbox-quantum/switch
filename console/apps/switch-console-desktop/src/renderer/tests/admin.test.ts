import { describe, expect, it } from 'vitest';
import { settingsForAdminSection } from '@renderer/features/admin/admin-sections';
import { switchStanding, switchTiles } from '@renderer/features/admin/workspace-switches';
import type {
  ConnectionCatalogEntry,
  WorkspaceService,
} from '@shared/core/switch-servers/connection-catalog';

function service(overrides: Partial<WorkspaceService> = {}): WorkspaceService {
  return {
    slug: 'example',
    name: 'Example',
    enabled: true,
    updated_by_name: null,
    updated_at: null,
    connected_members: 0,
    granted_agents: 0,
    unavailable_code: null,
    unavailable_reason: null,
    can_change: true,
    organization_locked: false,
    ...overrides,
  };
}

function entry(slug: string, category: string): ConnectionCatalogEntry {
  return {
    slug,
    name: slug,
    category,
    description: '',
    enabled: true,
    auth_type: 'oauth',
    connectable: true,
    status: 'not_connected',
    unavailable_reason: null,
    unavailable_code: null,
    read_only_reason: null,
    pass_through: true,
    token_lifetime: 3600,
    agent_access_note: null,
    loopback_ports: null,
    key: null,
    sign_in_choices: null,
    paste: [],
    method: null,
    access_note: null,
    reconnect_code: null,
    reconnect_reason: null,
    external_identity: null,
    choices: null,
    consent: null,
    workspace_enabled: true,
    organization_locked: false,
  };
}

describe('where an Admin link lands now that its pages are in Settings', () => {
  it('opens the Settings tab each section became', () => {
    expect(settingsForAdminSection('messaging-apps')).toEqual({ tab: 'messaging-apps' });
    expect(settingsForAdminSection('connectors')).toEqual({ tab: 'connectors' });
    expect(settingsForAdminSection('decision')).toEqual({ tab: 'decision-routing' });
    expect(settingsForAdminSection('switch-trust')).toEqual({ tab: 'guardrails' });
    expect(settingsForAdminSection('apps')).toEqual({ tab: 'connector-apps' });
  });

  it('keeps the connector app a link opened, and only on Connector apps', () => {
    expect(settingsForAdminSection('apps', 'github')).toEqual({
      tab: 'connector-apps',
      app: 'github',
    });
    expect(settingsForAdminSection('connectors', 'github')).toEqual({ tab: 'connectors' });
  });

  it('opens Preferences for a section it does not know, or none', () => {
    expect(settingsForAdminSection('nonsense')).toEqual({ tab: 'preferences' });
    expect(settingsForAdminSection(undefined)).toEqual({ tab: 'preferences' });
    expect(settingsForAdminSection('constructor')).toEqual({ tab: 'preferences' });
  });
});

describe('the workspace switches as tiles', () => {
  const services = [
    service({ slug: 'atlassian', name: 'Atlassian' }),
    service({ slug: 'linear', name: 'Linear', enabled: false }),
    service({ slug: 'figma', name: 'Figma' }),
  ];
  const catalog = [entry('atlassian', 'Project management'), entry('figma', 'Design')];

  it('keeps the server’s order whatever each switch says, with the catalog’s category', () => {
    expect(switchTiles(services, catalog, '')).toEqual([
      { service: services[0], category: 'Project management' },
      { service: services[1], category: null },
      { service: services[2], category: 'Design' },
    ]);
  });

  it('has no category before the catalog is read', () => {
    expect(switchTiles(services, undefined, '').map((tile) => tile.category)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('searches by name and by category, ignoring case', () => {
    expect(switchTiles(services, catalog, ' LIN ').map((tile) => tile.service.slug)).toEqual([
      'linear',
    ]);
    expect(switchTiles(services, catalog, 'design').map((tile) => tile.service.slug)).toEqual([
      'figma',
    ]);
    expect(switchTiles(services, catalog, 'nothing')).toEqual([]);
  });

  it('says who a switch reaches', () => {
    expect(switchStanding(service())).toBe('Nobody has connected it yet');
    expect(switchStanding(service({ connected_members: 1, granted_agents: 0 }))).toBe(
      '1 member connected · 0 agents use it'
    );
    expect(switchStanding(service({ connected_members: 3, granted_agents: 1 }))).toBe(
      '3 members connected · 1 agent uses it'
    );
  });

  it('says nothing of who a switch reaches when the server keeps it to admins', () => {
    expect(switchStanding(service({ connected_members: null, granted_agents: null }))).toBeNull();
  });
});
