import { describe, expect, it } from 'vitest';
import type { Workspace } from '@shared/core/workspaces/workspaces';
import { organizationGuardrailsWay } from './organization-guardrails';

const server = { url: 'https://switch.example.test', dashboardUrl: null };

function workspace(overrides: Partial<Workspace>): Workspace {
  return {
    id: 'w1',
    serverId: 's1',
    name: 'Acme',
    tenantId: 't1',
    slug: 'acme',
    role: 'member',
    organizationId: 'o1',
    organizationName: 'Acme Group',
    organizationRole: 'member',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...overrides,
  };
}

describe('organizationGuardrailsWay', () => {
  it("opens the organization's guardrails, in the workspace, for one of its admins", () => {
    expect(organizationGuardrailsWay(server, workspace({ organizationRole: 'org_admin' }))).toEqual(
      {
        kind: 'open',
        url: 'https://switch.example.test/settings/org/guardrails?workspace=t1',
      }
    );
  });

  it("says why there is no way there for an operator who isn't one of its admins", () => {
    const way = organizationGuardrailsWay(server, workspace({ organizationRole: 'member' }));
    expect(way).toEqual({
      kind: 'not-an-admin',
      text: "Only Acme Group's admins can set its guardrails, in its organization settings, and you aren't one of them.",
    });
  });

  it('offers no way there before the workspace is known', () => {
    expect(organizationGuardrailsWay(server, null).kind).toBe('not-an-admin');
    expect(
      organizationGuardrailsWay(
        server,
        workspace({ organizationRole: 'org_admin', tenantId: null })
      ).kind
    ).toBe('not-an-admin');
  });
});
