import { describe, expect, it } from 'vitest';
import type { OrganizationRole, Workspace } from '@shared/core/workspaces/workspaces';
import { groupByOrganization, switcherSections } from './organization-groups';

function workspace(
  id: string,
  organization: { id: string; name: string | null; role: OrganizationRole } | null,
  patch: Partial<Workspace> = {}
): Workspace {
  return {
    id,
    serverId: 'srv-1',
    name: id,
    tenantId: `tenant-${id}`,
    slug: id,
    role: 'member',
    organizationId: organization?.id ?? null,
    organizationName: organization?.name ?? null,
    organizationRole: organization?.role ?? null,
    createdAt: '',
    updatedAt: '',
    ...patch,
  };
}

const ACME_ADMIN = { id: 'o-1', name: 'Acme', role: 'org_admin' } as const;
const GLOBEX_MEMBER = { id: 'o-2', name: 'Globex', role: 'member' } as const;

describe('groupByOrganization', () => {
  it('groups by organization, in the order each first appears', () => {
    const groups = groupByOrganization([
      workspace('a', ACME_ADMIN),
      workspace('b', GLOBEX_MEMBER),
      workspace('c', ACME_ADMIN),
    ]);

    expect(groups.map((g) => [g.name, g.workspaces.map((w) => w.id)])).toEqual([
      ['Acme', ['a', 'c']],
      ['Globex', ['b']],
    ]);
  });

  it('keeps a server from before organizations as one unnamed group', () => {
    const groups = groupByOrganization([workspace('a', null), workspace('b', null)]);

    expect(groups).toEqual([
      { organizationId: null, name: null, workspaces: [expect.anything(), expect.anything()] },
    ]);
  });
});

describe('switcherSections', () => {
  it('heads each organization where there are several, all named', () => {
    const { sections, headed } = switcherSections([
      workspace('a', ACME_ADMIN),
      workspace('b', GLOBEX_MEMBER),
    ]);

    expect(headed).toBe(true);
    expect(sections.map((s) => s.name)).toEqual(['Acme', 'Globex']);
  });

  it('heads nothing where there is one organization', () => {
    const { sections, headed } = switcherSections([workspace('a', ACME_ADMIN)]);

    expect(headed).toBe(false);
    expect(sections.map((s) => s.name)).toEqual(['Acme']);
  });

  it('lists everything in one run, in order, where an organization has no name', () => {
    const unnamed = { id: 'o-2', name: null, role: 'member' } as const;
    const { sections, headed } = switcherSections([
      workspace('a', ACME_ADMIN),
      workspace('b', unnamed),
      workspace('c', ACME_ADMIN),
    ]);

    expect(headed).toBe(false);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.organizationId).toBeNull();
    expect(sections[0]!.workspaces.map((w) => w.id)).toEqual(['a', 'b', 'c']);
  });
});
