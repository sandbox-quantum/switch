import { expect } from 'vitest';
import { SwitchHttpError } from '../clients/switch-client.ts';
import type { FastScenario } from './scenario.ts';

/**
 * Anyone signed in creates an organization, and its admin adds workspaces to
 * it: a new user, in the default workspace, creates an organization and lands
 * in its first workspace, renames it, adds a second, and sees both, the first
 * by its new name, in an organization listed beside those they were already
 * in, with nothing left for its admin to fix, no Switch Trust policy
 * connected, and each new workspace counted with its one user and no agents.
 * It archives the second and restores it, and may not archive the one it is
 * in. It renames the organization and the second workspace from the
 * organization, invites the member to the second, makes them its admin and
 * removes them again. A plain member of the default workspace may not add one
 * there, rename it, or read its organization's guardrails.
 *
 * Users and workspaces cannot be deleted, so this runs only on a stack thrown
 * away after the run.
 */
export const organizations: FastScenario = {
  header: {
    id: 'organizations',
    covers: [
      'GET /gateway/organizations',
      'POST /gateway/organizations',
      'GET /gateway/organizations/current',
      'GET /gateway/organizations/current/issues',
      'GET /gateway/organizations/current/guardrails',
      'DELETE /gateway/organizations/current/guardrails',
      'GET /gateway/organizations/current/workspaces',
      'POST /gateway/organizations/current/workspaces',
      'POST /gateway/organizations/current/workspaces/{workspace_id}/archive',
      'POST /gateway/organizations/current/workspaces/{workspace_id}/restore',
      'POST /gateway/organizations/current/workspaces/{workspace_id}/members',
      'POST /gateway/organizations/current/workspaces/{workspace_id}/invitations',
      'DELETE /gateway/organizations/current/workspaces/{workspace_id}/members/{user_id}',
      'GET /gateway/organizations/current/workspaces/{workspace_id}/members/{user_id}/removal',
      'PATCH /gateway/organizations/current/workspaces/{workspace_id}/members/{user_id}',
      'PUT /gateway/organizations/current/workspaces/{workspace_id}/admins',
      'PATCH /gateway/organizations/current/workspaces/{workspace_id}',
      'PATCH /gateway/organizations/current',
      'GET /gateway/tenants/counts',
      'PATCH /gateway/tenants/{tenant_id}',
    ],
    lane: 'fast',
    environments: ['ephemeral'],
    owner: 'platform',
    requires: [],
  },
  async run({ names, switchClient }) {
    const password = `e2e-${names.runId}-${crypto.randomUUID()}`;
    const founderEmail = `${names.name('founder')}@e2e.invalid`;
    const memberEmail = `${names.name('member')}@e2e.invalid`;
    await switchClient.createUser({
      name: 'E2E founder',
      email: founderEmail,
      password,
      role: 'user',
    });
    await switchClient.createUser({
      name: 'E2E member',
      email: memberEmail,
      password,
      role: 'user',
    });
    const founder = switchClient.as(founderEmail, password);
    const member = switchClient.as(memberEmail, password);
    // Signing in joins the default workspace, and so its organization.
    const defaultWorkspace = await founder.tenantId();
    await member.tenantId();
    // The default workspace's organization is listed too, if it has one.
    const before = await founder.organizations();

    try {
      await member.createOrganizationWorkspace(names.name('not-theirs'));
      throw new Error('a member added a workspace to the organization');
    } catch (error) {
      if (!(error instanceof SwitchHttpError)) throw error;
      expect(error.status, 'a member adding a workspace').toBe(403);
    }

    try {
      await member.renameTenant(defaultWorkspace, names.name('misnamed'));
      throw new Error('a member renamed the workspace');
    } catch (error) {
      if (!(error instanceof SwitchHttpError)) throw error;
      expect(error.status, 'a member renaming the workspace').toBe(403);
    }

    try {
      await member.organizationGuardrails();
      throw new Error("a member read the organization's guardrails");
    } catch (error) {
      if (!(error instanceof SwitchHttpError)) throw error;
      expect(error.status, "a member reading the organization's guardrails").toBe(403);
    }

    const { organization, workspace } = await founder.createOrganization(names.name('org'));
    expect(organization.role).toBe('org_admin');
    expect(workspace).toMatchObject({
      role: 'admin',
      organization_role: 'org_admin',
      organization_id: organization.id,
    });
    expect(await founder.tenantId(), 'switched into the first workspace').toBe(workspace.id);
    expect(await founder.currentOrganization()).toMatchObject({
      id: organization.id,
      role: 'org_admin',
    });

    const renamed = names.name('renamed');
    expect(
      await founder.renameTenant(workspace.id, `  ${renamed}  `),
      'the new name, trimmed'
    ).toEqual({ id: workspace.id, name: renamed });

    const second = await founder.createOrganizationWorkspace(names.name('second'));
    expect(second.organization_id).toBe(organization.id);
    expect(await founder.tenantId(), 'still in the first workspace').toBe(workspace.id);

    const workspaces = await founder.organizationWorkspaces();
    expect(workspaces.map((row) => row.id).sort()).toEqual([workspace.id, second.id].sort());
    expect(workspaces.map((row) => row.id)).not.toContain(defaultWorkspace);
    expect(
      workspaces.find((row) => row.id === workspace.id)?.name,
      'the organization lists it by its new name'
    ).toBe(renamed);

    expect(await founder.organizationIssues(), 'nothing to fix in a new organization').toEqual([]);

    const archived = await founder.archiveOrganizationWorkspace(second.id);
    expect(archived.archived_at, 'archived').not.toBeNull();
    expect(
      (await founder.organizationWorkspaces()).find((row) => row.id === second.id),
      'an organization admin still sees an archived workspace'
    ).toBeDefined();
    expect(
      (await founder.restoreOrganizationWorkspace(second.id)).archived_at,
      'restored'
    ).toBeNull();
    try {
      await founder.addToOrganizationWorkspace(second.id, await member.userId(), 'member');
      throw new Error('someone outside the organization was added to a workspace of it');
    } catch (error) {
      if (!(error instanceof SwitchHttpError)) throw error;
      expect(error.status, 'adding someone outside the organization').toBe(404);
    }
    try {
      await founder.archiveOrganizationWorkspace(workspace.id);
      throw new Error('the workspace the session is in was archived');
    } catch (error) {
      if (!(error instanceof SwitchHttpError)) throw error;
      expect(error.status, 'archiving the workspace you are in').toBe(409);
    }

    expect(
      await founder.organizationGuardrails(),
      'a new organization starts with no Switch Trust policy'
    ).toMatchObject({ connected: false, policy_id: null });
    expect(
      await founder.disconnectOrganizationGuardrails(),
      'disconnecting none changes nothing'
    ).toMatchObject({ connected: false });

    const counts = await founder.workspaceCounts();
    for (const id of [workspace.id, second.id]) {
      expect(
        counts.find((row) => row.id === id),
        'a new workspace counts its admin and nothing else'
      ).toEqual({ id, users: 1, agents: 0 });
    }
    expect(counts.map((row) => row.id), 'the default workspace is counted too').toContain(
      defaultWorkspace
    );

    const listed = await founder.organizations();
    expect(listed.find((row) => row.id === organization.id)?.role).toBe('org_admin');
    expect(listed.map((row) => row.id).sort(), 'the new one beside the rest').toEqual(
      [...before.map((row) => row.id), organization.id].sort()
    );

    const orgName = names.name('org-renamed');
    expect((await founder.renameOrganization(orgName)).name, 'the organization renamed').toBe(
      orgName
    );
    expect((await founder.currentOrganization()).name).toBe(orgName);
    const secondName = names.name('second-renamed');
    expect(
      (await founder.renameOrganizationWorkspace(second.id, secondName)).name,
      'a workspace renamed from its organization'
    ).toBe(secondName);
    expect(
      (await founder.setOrganizationWorkspaceAdmins(second.id, [])).admins,
      'no admin to choose beside the organization admin who made it'
    ).toEqual([]);

    // The member joins the second workspace through a link made from the
    // organization, and is then made its admin and removed again.
    const memberId = await member.userId();
    await member.acceptInvitation(
      await founder.inviteToOrganizationWorkspace(second.id, 'member')
    );
    expect(
      (await founder.changeOrganizationWorkspaceRole(second.id, memberId, 'admin')).role
    ).toBe('admin');
    expect(
      (await founder.previewOrganizationWorkspaceRemoval(second.id, memberId)).handed_over_to
        ?.user_id,
      'what they own would pass to the organization admin removing them'
    ).toBe(await founder.userId());
    expect((await founder.removeFromOrganizationWorkspace(second.id, memberId)).ok).toBe(true);
  },
};
