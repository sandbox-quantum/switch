import type { NewAgentMachine } from '@shared/core/agent-migration/agent-migration';
import type { Agent } from '@shared/core/agents/agents';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import type { UiEntryPoint } from '@shared/core/telemetry/reporting';
import type { Workspace } from '@shared/core/workspaces/workspaces';
import type { AddAgentParams, AddAgentResult, NewAgentChecks } from '../agents/add-agent';
import type { MachineRef } from './agent-migration';
import type { MigrationLog, TargetLookup } from './agent-migration-service';
import type { ManagedAgentRecord } from './managed-agents-store';
import { buildManagedDefinition, type ManagedDefinition } from './managed-definition';

/** What the create form asks for when the agent runs as a managed agent on one of the user's machines. */
export type AddManagedAgentParams = {
  /** Where the agent runs: an `~/.ssh/config` Host alias, or null for this computer. */
  sshHost: string | null;
  /** The working directory, absolute on the agent's machine. */
  dir: string;
  name: string;
  providerId: AgentProviderId;
  serverId: string;
  description: string;
  displayName: string | null;
  /** Null means the form offered no choice: the agent gets the avatar its name generates. */
  iconUrl: string | null;
  autoApprove: boolean;
  instructions: string;
  /** Null runs the provider's default model. */
  model: string | null;
  entryPoint: UiEntryPoint;
};

export type AddManagedAgentResult =
  | AddAgentResult
  /** The machine cannot take a managed agent now. Nothing was created. */
  | { kind: 'machine-unavailable'; message: string };

export type ManagedCreateOutcome =
  | { kind: 'created'; switchAgentId: string }
  | { kind: 'name-conflict' }
  /** Switch refused the agent or its placement, in its own words. */
  | { kind: 'refused'; message: string };

export type NewManagedAgentDeps = {
  check(params: AddAgentParams): Promise<NewAgentChecks>;
  machine(ref: MachineRef): Promise<TargetLookup>;
  /** Whether the server runs agent management at all, asked through the workspace's session. */
  managementAvailable(workspaceId: string): Promise<boolean>;
  management: {
    create(
      workspaceId: string,
      body: {
        name: string;
        description: string;
        display_name: string | null;
        controller_id: string;
        desired_state: 'running' | 'stopped';
        definition: ManagedDefinition;
      }
    ): Promise<ManagedCreateOutcome>;
    setIcon(workspaceId: string, switchAgentId: string, iconUrl: string): Promise<void>;
    setDesiredState(
      workspaceId: string,
      switchAgentId: string,
      desiredState: 'running' | 'stopped'
    ): Promise<void>;
    release(workspaceId: string, switchAgentId: string): Promise<void>;
    /** Deletes the agent itself on Switch, so its name is free again. */
    deleteAgent(workspaceId: string, switchAgentId: string): Promise<void>;
  };
  /** The avatar an agent with no chosen icon is registered with. */
  defaultIcon(name: string): string;
  /** Writes the agent's config file into its working directory, as a Console-run agent has. */
  writeConfig(params: AddAgentParams): Promise<void>;
  store: {
    set(record: ManagedAgentRecord): Promise<void>;
    delete(agentId: string): Promise<void>;
  };
  rows: {
    create(input: {
      id: string;
      params: AddAgentParams;
      switchAgentId: string;
      server: SwitchServer;
      workspace: Workspace;
    }): Promise<Agent>;
    discard(agentId: string): Promise<void>;
  };
  /** Shows the new agent in Console: opens its location, and tells the app it exists. */
  announce(agent: Agent, entryPoint: UiEntryPoint): Promise<void>;
  newId(): string;
  now(): number;
  log: MigrationLog;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asAddAgentParams(params: AddManagedAgentParams): AddAgentParams {
  return {
    sshHost: params.sshHost,
    dir: params.dir,
    name: params.name,
    providerId: params.providerId,
    serverId: params.serverId,
    description: params.description,
    displayName: params.displayName,
    iconUrl: params.iconUrl,
    autoApprove: params.autoApprove,
    instructions: params.instructions,
    definitionAttributes: params.model ? { model: params.model } : {},
    providerConfig: null,
    entryPoint: params.entryPoint,
  };
}

/**
 * Creates a new agent as a managed agent on one of the user's machines (this
 * computer or an SSH host), the way the gateway and the `create_agent`
 * operation do: Switch registers it and places it on the machine's controller,
 * which runs it. Console keeps a row for it like an agent moved there, so it is
 * listed with the others and "Stop managing" can bring it back.
 *
 * In order:
 * 1. The same checks as a Console-run agent, then the machine. Nothing is
 *    created if either refuses.
 * 2. Switch registers and places it, stopped. Switch checks the placement
 *    first, so a refusal leaves nothing behind.
 * 3. Its icon, its config file, the managed record (so Console never starts a
 *    watcher of its own for it), then its row; then it is set running. A
 *    failure here undoes everything, the agent on Switch included.
 */
export class NewManagedAgentService {
  constructor(private readonly deps: NewManagedAgentDeps) {}

  /** Whether a new agent on this machine runs as a managed agent, and whether the machine can take it now. */
  async machineFor(ref: MachineRef & { workspaceId: string }): Promise<NewAgentMachine> {
    if (!(await this.deps.managementAvailable(ref.workspaceId))) return { management: false };
    const lookup = await this.deps.machine(ref);
    let blocker = lookup.blocker;
    if (!blocker && lookup.target && lookup.target.workspaceId !== ref.workspaceId)
      blocker =
        'The machine runs managed agents for another workspace on this server; an agent can only be placed on a machine of its own workspace.';
    return { management: true, target: lookup.display, blocker, canEnable: lookup.canEnable };
  }

  async add(input: AddManagedAgentParams): Promise<AddManagedAgentResult> {
    const params = asAddAgentParams(input);
    const checked = await this.deps.check(params);
    if (checked.kind !== 'ok') return checked;
    const { server, workspace } = checked;

    const lookup = await this.deps.machine({
      serverId: input.serverId,
      workspaceId: workspace.id,
      sshHost: input.sshHost,
    });
    if (!lookup.target)
      return {
        kind: 'machine-unavailable',
        message: lookup.blocker ?? 'There is no machine to place the agent on.',
      };
    const target = lookup.target;
    if (target.workspaceId !== workspace.id)
      return {
        kind: 'machine-unavailable',
        message:
          'The machine runs managed agents for another workspace on this server; an agent can only be placed on a machine of its own workspace.',
      };

    let definition: ManagedDefinition;
    try {
      definition = buildManagedDefinition({
        providerId: input.providerId,
        specialization: { model: input.model ?? undefined, instructions: input.instructions },
        providerDefinition: false,
        autoApprove: input.autoApprove,
        directory: input.dir,
        stoppedByHand: false,
        shellSetup: false,
        chosenBinary: null,
        subagentDefinition: null,
      }).definition;
    } catch (error) {
      return { kind: 'error', message: message(error) };
    }

    const created = await this.deps.management.create(workspace.id, {
      name: input.name,
      description: input.description,
      display_name: input.displayName,
      controller_id: target.controllerId,
      desired_state: 'stopped',
      definition,
    });
    if (created.kind === 'name-conflict') return { kind: 'name-conflict' };
    if (created.kind === 'refused') return { kind: 'error', message: created.message };
    const switchAgentId = created.switchAgentId;

    const id = this.deps.newId();
    let row: Agent | null = null;
    try {
      await this.deps.management.setIcon(
        workspace.id,
        switchAgentId,
        input.iconUrl ?? this.deps.defaultIcon(input.name)
      );
      await this.deps.writeConfig(params);
      await this.deps.store.set({
        agentId: id,
        workspaceId: workspace.id,
        controllerId: target.controllerId,
        placement:
          target.display.kind === 'this-computer'
            ? { kind: 'this-computer', serverId: target.display.serverId }
            : {
                kind: 'ssh-host',
                sshHost: target.display.sshHost,
                serverId: target.display.serverId,
              },
        identities: [
          {
            switchAgentId,
            slug: input.name,
            subagent: null,
            credentialsStashed: false,
            controllerRoot: target.watcherRoot(switchAgentId),
          },
        ],
        movedAt: new Date(this.deps.now()).toISOString(),
      });
      row = await this.deps.rows.create({ id, params, switchAgentId, server, workspace });
      await this.deps.management.setDesiredState(workspace.id, switchAgentId, 'running');
    } catch (error) {
      this.deps.log.error('Could not finish creating a managed agent; undoing', {
        switchAgentId,
        error: message(error),
      });
      const leftOnSwitch = await this.undo(workspace.id, id, switchAgentId, row !== null);
      throw new Error(
        leftOnSwitch
          ? `Could not finish creating ${input.name}: ${message(error)}. Switch still lists the agent, which could not be deleted: delete it from the gateway before creating it again.`
          : `Could not finish creating ${input.name}, so nothing was kept: ${message(error)}`,
        { cause: error }
      );
    }

    this.deps.log.info('Created a managed agent', {
      agentId: id,
      switchAgentId,
      controllerId: target.controllerId,
    });
    try {
      await this.deps.announce(row, input.entryPoint);
    } catch (error) {
      this.deps.log.error('Created a managed agent but could not show it yet', {
        agentId: id,
        error: message(error),
      });
    }
    return { kind: 'created', agent: row };
  }

  /** Undoes a creation that failed after Switch registered the agent. True when Switch still lists it. */
  private async undo(
    workspaceId: string,
    agentId: string,
    switchAgentId: string,
    rowCreated: boolean
  ): Promise<boolean> {
    if (rowCreated)
      await this.quietly('discard the agent row', () => this.deps.rows.discard(agentId));
    await this.quietly('forget the managed record', () => this.deps.store.delete(agentId));
    await this.quietly('stop managing the agent', () =>
      this.deps.management.release(workspaceId, switchAgentId)
    );
    try {
      await this.deps.management.deleteAgent(workspaceId, switchAgentId);
      return false;
    } catch (error) {
      this.deps.log.error('Could not delete the agent on Switch after a failed create', {
        switchAgentId,
        error: message(error),
      });
      return true;
    }
  }

  private async quietly(what: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.deps.log.error(`Could not ${what}`, { error: message(error) });
    }
  }
}
