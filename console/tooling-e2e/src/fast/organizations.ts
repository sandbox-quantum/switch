import { expect } from 'vitest';
import { SwitchHttpError } from '../clients/switch-client.ts';
import type { FastScenario } from './scenario.ts';

/**
 * Anyone signed in creates an organization, and its admin adds workspaces to
 * it: a new user, in the default workspace, creates an organization and lands
 * in its first workspace, adds a second, and sees both, in an organization
 * listed beside those they were already in. A plain member of the default
 * workspace may not add one there.
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
      'GET /gateway/organizations/current/workspaces',
      'POST /gateway/organizations/current/workspaces',
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

    const { organization, workspace } = await founder.createOrganization(names.name('org'));
    expect(organization.role).toBe('org_admin');
    expect(workspace).toMatchObject({
      role: 'owner',
      organization_role: 'org_admin',
      organization_id: organization.id,
    });
    expect(await founder.tenantId(), 'switched into the first workspace').toBe(workspace.id);
    expect(await founder.currentOrganization()).toMatchObject({
      id: organization.id,
      role: 'org_admin',
    });

    const second = await founder.createOrganizationWorkspace(names.name('second'));
    expect(second.organization_id).toBe(organization.id);
    expect(await founder.tenantId(), 'still in the first workspace').toBe(workspace.id);

    const workspaces = await founder.organizationWorkspaces();
    expect(workspaces.map((row) => row.id).sort()).toEqual([workspace.id, second.id].sort());
    expect(workspaces.map((row) => row.id)).not.toContain(defaultWorkspace);

    const listed = await founder.organizations();
    expect(listed.find((row) => row.id === organization.id)?.role).toBe('org_admin');
    expect(listed.map((row) => row.id).sort(), 'the new one beside the rest').toEqual(
      [...before.map((row) => row.id), organization.id].sort()
    );
  },
};
