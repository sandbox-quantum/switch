import { describe, expect, it } from 'vitest';
import { adminGroups, shownAdminSection } from '@renderer/features/admin/admin-sections';
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
    pass_through: true,
    token_lifetime: 3600,
    agent_access_note: null,
    loopback_ports: null,
    access_levels: null,
    key: null,
    external_identity: null,
    consent: null,
    workspace_enabled: true,
  };
}

describe('the Admin page’s sections', () => {
  const person = {
    administers: false,
    operator: false,
    operatesGatewaylessServer: false,
    serviceConnections: true,
  };

  it('gives workspace admins its messaging apps, connector switches and decision routing', () => {
    expect(adminGroups({ ...person, administers: true })).toEqual([
      { scope: 'workspace', items: ['messaging-apps', 'connectors', 'decision'] },
    ]);
    expect(adminGroups(person)).toEqual([]);
  });

  it('hides decision routing from a member who is not the workspace’s admin', () => {
    const member = adminGroups({ ...person, serviceConnections: false });
    expect(member.flatMap((group) => group.items)).not.toContain('decision');
  });

  it('gives the server’s operator Switch Trust, and connector apps only on a Switch with no gateway', () => {
    const operator = { ...person, administers: true, operator: true };
    expect(adminGroups(operator)).toEqual([
      { scope: 'workspace', items: ['messaging-apps', 'connectors', 'decision'] },
      { scope: 'server', items: ['switch-trust'] },
    ]);
    expect(adminGroups({ ...operator, operatesGatewaylessServer: true })[1]).toEqual({
      scope: 'server',
      items: ['switch-trust', 'apps'],
    });
  });

  it('keeps only the connector sections behind service connections, not decision routing', () => {
    expect(
      adminGroups({
        administers: true,
        operator: true,
        operatesGatewaylessServer: true,
        serviceConnections: false,
      })
    ).toEqual([
      { scope: 'workspace', items: ['messaging-apps', 'decision'] },
      { scope: 'server', items: ['switch-trust'] },
    ]);
  });

  it('opens the section asked for when the person may use it, otherwise the first', () => {
    const operator = adminGroups({
      ...person,
      administers: true,
      operator: true,
      operatesGatewaylessServer: true,
    });
    const admin = adminGroups({ ...person, administers: true });
    expect(shownAdminSection(operator, 'apps')).toBe('apps');
    expect(shownAdminSection(admin, 'apps')).toBe('messaging-apps');
    expect(shownAdminSection(admin, 'connectors')).toBe('connectors');
    expect(shownAdminSection(admin, 'decision')).toBe('decision');
    expect(shownAdminSection([], 'connectors')).toBeNull();
    const off = adminGroups({ ...person, administers: true, serviceConnections: false });
    expect(shownAdminSection(off, 'connectors')).toBe('messaging-apps');
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
