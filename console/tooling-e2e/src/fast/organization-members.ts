import { expect } from 'vitest';
import { SwitchHttpError, errorDetail } from '../clients/switch-client.ts';
import type { FastScenario } from './scenario.ts';

/**
 * An organization's admins manage who else is one: the harness admin, the
 * default workspace's organization admin, lists its members, makes a
 * colleague organization admin, and takes it back. The colleague can list
 * the members only while they hold the role. The workspace roster shows each
 * person's organization role. Removing the colleague from the organization is
 * refused while they are still in its workspace, and goes through once they
 * are not. Only the harness admin, a platform operator, lists every
 * workspace.
 *
 * Users cannot be deleted, so this runs only on a stack thrown away after
 * the run.
 */
export const organizationMembers: FastScenario = {
  header: {
    id: 'organization-members',
    covers: [
      'GET /gateway/organizations/current/members',
      'PATCH /gateway/organizations/current/members/{user_id}',
      'DELETE /gateway/organizations/current/members/{user_id}',
      'GET /gateway/operator/workspaces',
      'GET /gateway/tenants/{tenant_id}/members',
      'DELETE /gateway/tenants/{tenant_id}/members/{user_id}',
    ],
    lane: 'fast',
    environments: ['ephemeral'],
    owner: 'platform',
    requires: [],
  },
  async run({ names, switchClient }) {
    const password = `e2e-${names.runId}-${crypto.randomUUID()}`;
    const email = `${names.name('colleague')}@e2e.invalid`;
    const { id } = await switchClient.createUser({
      name: 'E2E colleague',
      email,
      password,
      role: 'user',
    });
    const colleague = switchClient.as(email, password);
    // Signing in joins the default workspace, and so its organization.
    await colleague.tenantId();

    const refused = async (): Promise<number> => {
      try {
        await colleague.organizationMembers();
      } catch (error) {
        if (error instanceof SwitchHttpError) return error.status;
        throw error;
      }
      return 200;
    };

    const before = await switchClient.organizationMembers();
    expect(before.find((row) => row.user_id === id)?.role, 'a new member').toBe('member');
    expect(await refused(), 'a member listing the organization').toBe(403);

    const granted = await switchClient.setOrganizationRole(id, 'org_admin');
    expect(granted.role).toBe('org_admin');
    expect(await refused(), 'an organization admin listing the organization').toBe(200);

    const taken = await switchClient.setOrganizationRole(id, 'member');
    expect(taken.role).toBe('member');
    expect(await refused(), 'a member again').toBe(403);

    const status = async (call: () => Promise<unknown>): Promise<[number, string]> => {
      try {
        await call();
      } catch (error) {
        if (error instanceof SwitchHttpError) return [error.status, errorDetail(error.body)];
        throw error;
      }
      return [200, ''];
    };

    const [unknownRole] = await status(() =>
      switchClient.setOrganizationRole(id, 'owner' as 'member')
    );
    expect(unknownRole, 'an unknown organization role').toBe(422);

    const tenantId = await switchClient.tenantId();
    const roster = await switchClient.workspaceMembers(tenantId);
    expect(
      roster.find((row) => row.user_id === id),
      'the colleague on the workspace roster'
    ).toMatchObject({ role: 'member', organization_role: 'member', via_organization: false });

    const everyWorkspace = await switchClient.operatorWorkspaces();
    expect(everyWorkspace.map((row) => row.id), 'the operator list').toContain(tenantId);
    const [notOperator] = await status(() => colleague.operatorWorkspaces());
    expect(notOperator, 'a non-operator listing every workspace').toBe(403);

    const [stillIn, why] = await status(() => switchClient.removeOrganizationMember(id));
    expect(stillIn, 'removing someone still in a workspace').toBe(409);
    expect(why).toContain('first');

    await switchClient.removeWorkspaceMember(tenantId, id);
    await switchClient.removeOrganizationMember(id);
    const after = await switchClient.organizationMembers();
    expect(after.map((row) => row.user_id), 'removed from the organization').not.toContain(id);
  },
};
