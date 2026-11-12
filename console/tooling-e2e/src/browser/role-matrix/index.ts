import { expect } from 'vitest';
import {
  AREAS,
  PAGES,
  PERSONAS,
  type Persona,
} from '../../../../../gateway/src/routes/roleMatrix.ts';
import type { SwitchClient } from '../../clients/switch-client.ts';
import type { ScenarioHeader } from '../../core/scenario.ts';
import type { GatewayUi } from '../gateway-ui.ts';
import type { BrowserScenario } from '../scenario.ts';
import {
  checkPages,
  checkRail,
  checkRedirects,
  checkSettingsMenus,
  landingOf,
  openAndCompare,
} from './checks.ts';
import {
  PERSONA_TAG,
  RoleWorld,
  type Account,
  type Organization,
  type PageObjects,
} from './world.ts';

/**
 * The role matrix, end to end: for each role, a real account signs in and is
 * shown exactly what `gateway/src/routes/roleMatrix.ts` says, in whichever
 * layout the server runs (the lane runs once with `gateway_v2` off and once
 * with it on). Then the same person in two workspaces, and in two
 * organizations, switching with the app's own switcher.
 *
 * What a scenario checks beyond the matrix is every browser scenario's: a
 * page that renders but is broken, or makes a request the server refuses,
 * fails it (`GatewayUi`).
 */

/** The flags every row of the matrix assumes are on. */
const MATRIX_FLAGS = ['agent_management', 'service_connections', 'organization_connector_apps'];

async function requireMatrixFlags(switchClient: SwitchClient): Promise<void> {
  const on = await switchClient.enabledFeatureFlags();
  const off = MATRIX_FLAGS.filter((flag) => !on.has(flag));
  if (off.length > 0) {
    throw new Error(
      `The role matrix assumes ${off.join(', ')} on, and this server has them off. ` +
        "The browser lane's stack (scripts/ephemeral-stack.sh) turns them on."
    );
  }
}

/**
 * Accounts and organizations outlive a scenario, so only on a stack thrown
 * away after the run.
 */
function roleMatrixHeader(id: string, covers: string[]): ScenarioHeader {
  return {
    id,
    covers,
    lane: 'browser',
    environments: ['ephemeral'],
    owner: 'platform',
    requires: ['gateway-ui'],
  };
}

const KEBAB: Record<Persona, string> = {
  orgAdmin: 'org-admin',
  workspaceAdmin: 'workspace-admin',
  member: 'member',
  operator: 'operator',
};

/** `persona`'s account in `organization`'s first workspace, and one of everything they own there. */
async function personaIn(
  world: RoleWorld,
  organization: Organization,
  persona: Persona
): Promise<{ account: Account; objects: PageObjects }> {
  let account: Account;
  switch (persona) {
    case 'orgAdmin':
      account = organization.admin;
      break;
    case 'workspaceAdmin':
    case 'member':
      account = await world.account(PERSONA_TAG[persona], KEBAB[persona].replace('-', ' '));
      await world.invite(
        organization.admin,
        organization.workspace,
        account,
        persona === 'workspaceAdmin' ? 'admin' : 'member'
      );
      break;
    case 'operator':
      account = await world.operatorIn(organization.workspace);
      break;
  }
  return { account, objects: await world.objects(account, PERSONA_TAG[persona]) };
}

/**
 * What making the scenario's people and things calls, and what the pages
 * they open read, for every role. Each was seen answered in a run of both
 * layouts; a route a page stops reading should come off.
 */
const EVERY_ROLE: readonly string[] = [
  'POST /gateway/users',
  'POST /gateway/organizations',
  'POST /gateway/references',
  'DELETE /gateway/references/{reference_id}',
  'POST /gateway/documents',
  'DELETE /gateway/documents/{document_id}',
  'POST /gateway/rooms/{room_id}/documents/{document_id}',
  'POST /gateway/packages',
  'DELETE /gateway/packages/{package_id}',
  'POST /gateway/templates',
  'DELETE /gateway/templates/{template_id}',
  'DELETE /gateway/rooms/{room_id}',
  'GET /gateway/feature-flags',
  'GET /gateway/tenants/current',
  'GET /gateway/api-keys',
  'GET /gateway/collaborations',
  'GET /gateway/collaborations/types',
  'GET /gateway/messaging-apps',
  'GET /gateway/messaging-apps/installs',
  'GET /gateway/ecosystem/graph',
  'GET /gateway/linked-rooms/graph',
  'GET /gateway/room-groups',
  'GET /gateway/rooms/{room_id}/documents',
  'GET /gateway/rooms/{room_id}/documents/{document_id}',
  'GET /gateway/rooms/{room_id}/references',
  'GET /gateway/rooms/{room_id}/linked-rooms',
  'GET /gateway/rooms/{room_id}/linked-rooms/inbound',
  'GET /gateway/references',
  'GET /gateway/references/reference-types',
  'GET /gateway/references/{reference_id}',
  'GET /gateway/references/{reference_id}/rooms',
  'GET /gateway/documents',
  'GET /gateway/documents/{document_id}',
  'GET /gateway/documents/{document_id}/rooms',
  'GET /gateway/packages',
  'GET /gateway/packages/{package_id}',
  'GET /gateway/packages/{package_id}/documents',
  'GET /gateway/packages/{package_id}/references',
  'GET /gateway/packages/{package_id}/rooms',
  'GET /gateway/templates',
  'GET /gateway/templates/{template_id}',
  'POST /gateway/templates/validate',
  'GET /gateway/service-connections',
  'GET /gateway/management/agents',
  'GET /gateway/management/controllers',
  'GET /gateway/management/operations',
  'GET /gateway/management/providers',
];

/** What only some roles reach: the routes making them calls, and the pages only they may open. */
const BY_ROLE: Record<Persona, readonly string[]> = {
  orgAdmin: [
    'GET /gateway/api-keys/workspace',
    'GET /gateway/tenants/{tenant_id}/budgets',
    'GET /gateway/tenants/{tenant_id}/usage',
    'GET /gateway/tenants/{tenant_id}/invitations',
  ],
  workspaceAdmin: [
    'GET /gateway/api-keys/workspace',
    'POST /gateway/tenants/{tenant_id}/invitations',
    'POST /gateway/invitations/accept',
    'GET /gateway/tenants/{tenant_id}/budgets',
    'GET /gateway/tenants/{tenant_id}/usage',
    'GET /gateway/tenants/{tenant_id}/invitations',
  ],
  member: ['POST /gateway/tenants/{tenant_id}/invitations', 'POST /gateway/invitations/accept'],
  operator: [
    'GET /gateway/api-keys/workspace',
    'POST /gateway/tenants/{tenant_id}/switch',
    'GET /gateway/tenants/{tenant_id}/budgets',
    'GET /gateway/tenants/{tenant_id}/usage',
    'GET /gateway/tenants/{tenant_id}/invitations',
    'GET /gateway/connector-apps',
    'GET /gateway/users',
  ],
};

function personaScenario(persona: Persona): BrowserScenario {
  return {
    header: roleMatrixHeader(`role-matrix-${KEBAB[persona]}`, [...EVERY_ROLE, ...BY_ROLE[persona]]),
    async run({ env, names, switchClient, fixtures, ui, log }) {
      await requireMatrixFlags(switchClient);
      const world = new RoleWorld(switchClient, env.switch, names, fixtures);
      const organization = await world.organization('oa');
      const { account, objects } = await personaIn(world, organization, persona);

      await ui.signInAs(account);
      // Signing in never selects a workspace the operator holds no role in.
      if (persona === 'operator') await ui.enterWorkspace(organization.workspace.id);
      expect(await ui.workspaceId(), "in the organization's workspace").toBe(
        organization.workspace.id
      );

      const wrong = [
        ...(await checkRail(ui, persona)),
        ...(await checkSettingsMenus(ui, persona)),
        ...(await checkPages(ui, persona, objects, log)),
        ...(await checkRedirects(ui, persona, objects, log)),
      ];
      expect(
        wrong,
        `the dashboard and the role matrix disagree for ${persona}:\n  ${wrong.join('\n  ')}\n`
      ).toEqual([]);
    },
  };
}

/**
 * What tells one role's view from another's: the rail, the settings menus,
 * every page that not everyone may open, and, in the new layout, whether the
 * switcher offers to invite people. `asPersona` is the role the person holds
 * where they are now.
 */
async function checkView(ui: GatewayUi, asPersona: Persona, where: string): Promise<string[]> {
  const wrong = [...(await checkRail(ui, asPersona)), ...(await checkSettingsMenus(ui, asPersona))];
  // Their paths name nothing, so there is nothing to fill in.
  const sensitive = [...AREAS[ui.layout], ...PAGES[ui.layout]].filter(
    (row) => row.open.length < PERSONAS.length && !row.path.includes(':')
  );
  for (const { path } of sensitive) {
    const problem = await openAndCompare(ui, path, landingOf(ui.layout, asPersona, path));
    if (problem !== null) wrong.push(problem);
  }
  // Back where the switcher is: organization settings show none.
  await ui.open(ui.landing);
  if (ui.layout === 'v2') {
    const invites = await ui.switcherOffersInvite();
    const administers = asPersona !== 'member';
    if (invites !== administers) {
      wrong.push(`the switcher ${invites ? 'offers' : 'does not offer'} to invite people`);
    }
  }
  return wrong.map((line) => `${where}: ${line}`);
}

/**
 * One person, an admin of one workspace and a member of another in the same
 * organization, switches between them with the app's switcher, and is shown
 * each workspace as their role there has it.
 */
const twoWorkspaces: BrowserScenario = {
  header: roleMatrixHeader('role-matrix-two-workspaces', [
    'POST /gateway/users',
    'POST /gateway/organizations',
    'POST /gateway/organizations/current/workspaces',
    'POST /gateway/tenants/{tenant_id}/invitations',
    'POST /gateway/invitations/accept',
    'POST /gateway/tenants/{tenant_id}/switch',
  ]),
  async run({ env, names, switchClient, fixtures, ui }) {
    await requireMatrixFlags(switchClient);
    const world = new RoleWorld(switchClient, env.switch, names, fixtures);
    const organization = await world.organization('oa');
    const second = await world.addWorkspace(organization.admin, 'ws2');
    const person = await world.account('wa', 'workspace admin');
    await world.invite(organization.admin, second, person, 'member');
    // Last, so signing in lands here.
    await world.invite(organization.admin, organization.workspace, person, 'admin');

    await ui.signInAs(person);
    expect(await ui.workspaceId()).toBe(organization.workspace.id);
    const wrong = await checkView(ui, 'workspaceAdmin', organization.workspace.name);
    await ui.switchWorkspace(second);
    wrong.push(...(await checkView(ui, 'member', second.name)));
    await ui.switchWorkspace(organization.workspace);
    wrong.push(
      ...(await checkView(ui, 'workspaceAdmin', `back in ${organization.workspace.name}`))
    );
    expect(wrong, `\n  ${wrong.join('\n  ')}\n`).toEqual([]);
  },
};

/**
 * One person, the admin of one organization and a plain member in another's
 * workspace: the switcher groups their workspaces by organization, the
 * organization's reach makes them an admin of a workspace a fellow admin
 * added, which they hold no membership of, and in the other organization
 * they are a member.
 */
const twoOrganizations: BrowserScenario = {
  header: roleMatrixHeader('role-matrix-two-organizations', [
    'POST /gateway/users',
    'POST /gateway/organizations',
    'POST /gateway/organizations/current/workspaces',
    'PATCH /gateway/organizations/current/members/{user_id}',
    'POST /gateway/tenants/{tenant_id}/invitations',
    'POST /gateway/invitations/accept',
    'POST /gateway/tenants/{tenant_id}/switch',
  ]),
  async run({ env, names, switchClient, fixtures, ui }) {
    await requireMatrixFlags(switchClient);
    const world = new RoleWorld(switchClient, env.switch, names, fixtures);
    const ours = await world.organization('oa');
    const colleague = await world.account('oa2', 'fellow organization admin');
    await world.invite(ours.admin, ours.workspace, colleague, 'member');
    await ours.admin.client.setOrganizationRole(colleague.id, 'org_admin');
    const second = await world.addWorkspace(colleague, 'ws2');
    const theirs = await world.organization('ob');
    await world.invite(theirs.admin, theirs.workspace, ours.admin, 'member');
    // Signing in lands on the workspace last chosen.
    await ours.admin.client.switchTenant(ours.workspace.id);

    await ui.signInAs(ours.admin);
    expect(await ui.workspaceId()).toBe(ours.workspace.id);
    const wrong: string[] = [];
    if (ui.layout === 'v2') {
      const headings = await ui.switcherOrganizations();
      for (const organization of [ours, theirs]) {
        if (!headings.includes(organization.name)) {
          wrong.push(
            `the switcher has no heading for ${organization.name} (it has ${headings.join(', ') || 'none'})`
          );
        }
      }
    }
    wrong.push(...(await checkView(ui, 'orgAdmin', ours.workspace.name)));
    await ui.switchWorkspace(second);
    wrong.push(...(await checkView(ui, 'orgAdmin', second.name)));
    await ui.switchWorkspace(theirs.workspace);
    wrong.push(...(await checkView(ui, 'member', theirs.workspace.name)));
    expect(wrong, `\n  ${wrong.join('\n  ')}\n`).toEqual([]);
  },
};

export const ROLE_MATRIX_SCENARIOS: readonly BrowserScenario[] = [
  ...PERSONAS.map(personaScenario),
  twoWorkspaces,
  twoOrganizations,
];
