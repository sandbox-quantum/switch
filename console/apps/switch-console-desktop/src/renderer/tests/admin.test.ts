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
    loopback_ports: null,
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
    serviceConnections: true,
    managed: false,
  };

  it('shows the workspace switches to its admins, and the apps under Server to the operator alone', () => {
    expect(adminGroups({ ...person, administers: true })).toEqual([
      { scope: 'workspace', items: ['connectors'] },
    ]);
    expect(adminGroups({ ...person, administers: true, operator: true })).toEqual([
      { scope: 'workspace', items: ['connectors'] },
      { scope: 'server', items: ['apps'] },
    ]);
    expect(adminGroups(person)).toEqual([]);
  });

  it('puts the status of a server this Console runs first under Server, for whoever runs it', () => {
    expect(adminGroups({ ...person, administers: true, operator: true, managed: true })).toEqual([
      { scope: 'workspace', items: ['connectors'] },
      { scope: 'server', items: ['status', 'apps'] },
    ]);
    expect(adminGroups({ ...person, managed: true })).toEqual([
      { scope: 'server', items: ['status'] },
    ]);
  });

  it('keeps the connector sections behind service connections, but not the status', () => {
    const off = { ...person, serviceConnections: false, administers: true, operator: true };
    expect(adminGroups(off)).toEqual([]);
    expect(adminGroups({ ...off, managed: true })).toEqual([
      { scope: 'server', items: ['status'] },
    ]);
  });

  it('opens the section asked for when the person may use it, otherwise the first', () => {
    const operator = adminGroups({ ...person, administers: true, operator: true });
    const admin = adminGroups({ ...person, administers: true });
    expect(shownAdminSection(operator, 'apps')).toBe('apps');
    expect(shownAdminSection(admin, 'apps')).toBe('connectors');
    expect(shownAdminSection(admin, undefined)).toBe('connectors');
    expect(shownAdminSection([], 'connectors')).toBeNull();
  });

  it('never opens the status as one of the page’s own sections', () => {
    const runner = adminGroups({ ...person, managed: true });
    expect(shownAdminSection(runner, undefined)).toBeNull();
    const operator = adminGroups({ ...person, administers: true, operator: true, managed: true });
    expect(shownAdminSection(operator, undefined)).toBe('connectors');
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
});
