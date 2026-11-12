import type { Persona } from '../../../../../gateway/src/routes/roleMatrix.ts';
import type { SwitchClient } from '../../clients/switch-client.ts';
import type { SwitchEnv } from '../../core/env.ts';
import type { NameScope } from '../../core/run.ts';
import type { Fixtures } from '../../fixtures/fixtures.ts';

/**
 * The people and places the role matrix is checked with, made fresh for each
 * scenario over HTTP, as the matrix describes them (`Persona`):
 *
 * - an organization, made by its organization admin, with its first
 *   workspace (where the matrix is checked) and a second one;
 * - a workspace admin and a member, each brought into the first workspace by
 *   an invitation link, as people join today;
 * - the platform operator, who is the harness's own gateway admin, holds no
 *   role in the organization, and enters the workspace from the operator's
 *   list of every workspace.
 *
 * Accounts and organizations cannot be removed afterwards, so the scenarios
 * that use this run only on a stack thrown away after the run.
 */

export interface Account {
  id: string;
  email: string;
  password: string;
  /** The account's own session, bound to whichever workspace it last chose. */
  client: SwitchClient;
}

export interface Workspace {
  id: string;
  name: string;
}

export interface Organization {
  name: string;
  /** Its first workspace. */
  workspace: Workspace;
  admin: Account;
}

/** One password for every account a scope makes: they all die with the stack. */
function scopePassword(names: NameScope): string {
  return `e2e-${names.runId}-${crypto.randomUUID()}`;
}

export class RoleWorld {
  private readonly admin: SwitchClient;
  private readonly operatorLogin: SwitchEnv;
  private readonly names: NameScope;
  private readonly fixtures: Fixtures;
  private readonly password: string;

  constructor(admin: SwitchClient, operatorLogin: SwitchEnv, names: NameScope, fixtures: Fixtures) {
    this.admin = admin;
    this.operatorLogin = operatorLogin;
    this.names = names;
    this.fixtures = fixtures;
    this.password = scopePassword(names);
  }

  /** A new account with no workspace of its own yet; `role` names it. */
  async account(role: string, label: string): Promise<Account> {
    const email = `${this.names.name(role)}@e2e.invalid`;
    const { id } = await this.admin.createUser({
      name: `E2E ${label}`,
      email,
      password: this.password,
      role: 'user',
    });
    return { id, email, password: this.password, client: this.admin.as(email, this.password) };
  }

  /** An organization, and its first workspace, made by a new account who is its admin. */
  async organization(role: string): Promise<Organization> {
    const admin = await this.account(role, 'organization admin');
    const { workspace } = await admin.client.createOrganization(this.names.name(`${role}-org`));
    return { name: workspace.name, workspace: { id: workspace.id, name: workspace.name }, admin };
  }

  /**
   * Another workspace in the organization `creator`'s session is in, named
   * for `role`. Only an organization admin may add one, and becomes its admin.
   */
  async addWorkspace(creator: Account, role: string): Promise<Workspace> {
    const workspace = await creator.client.createOrganizationWorkspace(this.names.name(role));
    return { id: workspace.id, name: workspace.name };
  }

  /**
   * Bring `account` into `workspace` with `role`, by an invitation link one of
   * its admins makes, as people join today. Accepting selects the workspace,
   * so the account's next sign-in lands there; the inviter's choice is left as
   * it was.
   */
  async invite(
    inviter: Account,
    workspace: Workspace,
    account: Account,
    role: 'admin' | 'member'
  ): Promise<void> {
    // An invitation is made from a session bound to its workspace.
    const before = await inviter.client.tenantId();
    if (before !== workspace.id) await inviter.client.switchTenant(workspace.id);
    const token = await inviter.client.createInvitation(workspace.id, role);
    if (before !== workspace.id) await inviter.client.switchTenant(before);
    await account.client.acceptInvitation(token);
  }

  /**
   * The platform operator, with a session of its own entered into
   * `workspace`, for making things there.
   *
   * The operator is the harness's gateway admin, and every switch of
   * workspace is remembered as the account's choice for its next sign-in. The
   * other browser scenarios sign in as this account and expect to land where
   * the lane's own session makes things, so that workspace is chosen again
   * straight away, and once more when the scenario ends.
   */
  async operatorIn(workspace: Workspace): Promise<Account> {
    const email = this.operatorLogin.gatewayAdminEmail;
    const password = this.operatorLogin.gatewayAdminPassword;
    const home = await this.admin.tenantId();
    // Before the first switch, so that whatever fails from here on, the
    // choice is still put back.
    const chooser = this.admin.as(email, password);
    this.fixtures.defer(`the operator's choice of workspace (${home})`, () =>
      chooser.switchTenant(home)
    );
    const client = this.admin.as(email, password);
    await client.switchTenant(workspace.id);
    await chooser.switchTenant(home);
    return { id: await client.userId(), email, password, client };
  }

  /**
   * One of everything a page of the dashboard opens by id, owned by `account`
   * in the workspace its session is bound to, so the page is theirs to open
   * whatever their role. Each is removed afterwards.
   */
  async objects(account: Account, tag: string): Promise<PageObjects> {
    const { client } = account;
    const description = `Made by the Switch end-to-end harness (run ${this.names.runId}). Safe to delete.`;

    const agent = await client.registerAgentAsUser({
      name: this.names.name(`${tag}-agent`),
      description,
    });
    this.fixtures.defer(`agent ${agent.name}`, () => client.deleteAgentByName(agent.name));

    const room = await client.createRoom({
      name: this.names.name(`${tag}-room`),
      description,
      bridgeId: null,
      agentNames: [agent.name],
      userNames: [],
    });
    this.fixtures.defer(`room ${room.name} (${room.id})`, () => client.deleteRoom(room.id));

    const referenceName = this.names.name(`${tag}-ref`);
    const reference = await client.createReference({
      name: referenceName,
      description,
      url: 'https://github.com/example/e2e',
    });
    this.fixtures.defer(`reference ${reference.id}`, () => client.deleteReference(reference.id));

    const documentName = this.names.name(`${tag}-doc`);
    const document = await client.createDocument({
      name: documentName,
      description,
      content: 'A document for the role matrix to open.',
    });
    this.fixtures.defer(`document ${document.id}`, () => client.deleteDocument(document.id));
    await client.attachDocumentToRoom(room.id, document.id);

    const pkg = await client.createPackage({
      name: this.names.name(`${tag}-pkg`),
      description,
      instructions: '',
    });
    this.fixtures.defer(`package ${pkg.id}`, () => client.deletePackage(pkg.id));

    const templateName = this.names.name(`${tag}-tpl`);
    const template = await client.createTemplate({
      name: templateName,
      description,
      content: `room:\n  name: ${templateName}\n  description: ${description}\n`,
    });
    this.fixtures.defer(`template ${template.id}`, () => client.deleteTemplate(template.id));

    return {
      roomId: room.id,
      agentId: agent.id,
      referenceId: reference.id,
      documentId: document.id,
      packageId: pkg.id,
      templateId: template.id,
      names: {
        [room.id]: room.name,
        [agent.id]: agent.name,
        [reference.id]: referenceName,
        [document.id]: documentName,
        [pkg.id]: pkg.name,
        [template.id]: templateName,
      },
    };
  }
}

/** The ids a page's path parameters are filled from, and each one's name. */
export interface PageObjects {
  roomId: string;
  agentId: string;
  referenceId: string;
  documentId: string;
  packageId: string;
  templateId: string;
  /** Each object's name, by its id. */
  names: Readonly<Record<string, string>>;
}

/** The name each persona's own objects are tagged with. */
export const PERSONA_TAG: Record<Persona, string> = {
  orgAdmin: 'oa',
  workspaceAdmin: 'wa',
  member: 'm',
  operator: 'op',
};
