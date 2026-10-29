import { expect } from 'vitest';
import { SwitchHttpError, errorDetail } from '../clients/switch-client.ts';
import type { FastScenario } from './scenario.ts';

/**
 * An organization's admins manage who else is one: the harness admin, the
 * default workspace's organization admin, lists its members, makes a
 * colleague organization admin, and takes it back. The colleague can list
 * the members only while they hold the role.
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

    try {
      await switchClient.setOrganizationRole(id, 'owner' as 'member');
      throw new Error('an unknown organization role was accepted');
    } catch (error) {
      if (!(error instanceof SwitchHttpError)) throw error;
      expect(error.status, errorDetail(error.body)).toBe(422);
    }
  },
};
