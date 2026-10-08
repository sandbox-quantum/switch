import type { AdvancedConfig } from '@switch-console/plugins/agents';
import type { NewAgentMachine } from '@shared/core/agent-migration/agent-migration';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type { UiEntryPoint } from '@shared/core/telemetry/reporting';
import type { MachineRef } from './agent-migration';
import type { MigrationLog, TargetLookup } from './agent-migration-service';
import { assertInstructionsFit, type ManagedDefinition } from './managed-definition';

/** What the create form asks for when the agent runs as a managed agent on one of the user's machines. */
export type AddManagedAgentParams = {
  /** The machine it runs on: the id of one of the owner's controllers on the server. */
  machineId: string;
  /** The working directory, absolute on the machine; null for a fresh workspace the machine chooses. */
  dir: string | null;
  name: string;
  providerId: AgentProviderId;
  serverId: string;
  description: string;
  displayName: string | null;
  /** Null means the form offered no choice: the server gives it the icon its name generates. */
  iconUrl: string | null;
  autoApprove: boolean;
  instructions: string;
  /** Null runs the provider's default model. */
  model: string | null;
  /** The provider's advanced configuration, keyed by its field keys; unset fields are absent. */
  advancedConfig: AdvancedConfig;
  entryPoint: UiEntryPoint;
};

export type AddManagedAgentResult =
  | { kind: 'created'; serverId: string; workspaceId: string; switchAgentId: string }
  | { kind: 'name-conflict' }
  | { kind: 'error'; message: string };

export type ManagedCreateOutcome =
  | { kind: 'created'; switchAgentId: string }
  | { kind: 'name-conflict' }
  /** Switch refused the agent or its placement, in its own words. */
  | { kind: 'refused'; message: string };

export type NewManagedAgentDeps = {
  /** The workspace the server's agents belong to. */
  workspaceFor(serverId: string): Promise<string>;
  machine(ref: MachineRef): Promise<TargetLookup>;
  /** Whether the server runs agent management at all, asked through the workspace's session. */
  managementAvailable(workspaceId: string): Promise<boolean>;
  create(
    workspaceId: string,
    body: {
      name: string;
      description: string;
      display_name: string | null;
      icon_url: string | null;
      controller_id: string;
      desired_state: 'running' | 'stopped';
      definition: ManagedDefinition;
    }
  ): Promise<ManagedCreateOutcome>;
  log: MigrationLog;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Creates a new agent as a managed agent on one of the user's machines on the
 * server (this computer, an SSH host, or any other), the way the gateway and the `create_agent`
 * operation do: Switch registers it and places it on the machine's controller,
 * which runs it. The server holds all of it; Console keeps no copy, and lists
 * it from the server like any other managed agent.
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

  /**
   * Creates it on the machine the form chose. Switch checks the placement (the
   * machine is the owner's, in this workspace, and can run the provider) and
   * refuses it in its own words.
   */
  async add(input: AddManagedAgentParams): Promise<AddManagedAgentResult> {
    const workspaceId = await this.deps.workspaceFor(input.serverId);

    try {
      assertInstructionsFit(input.instructions);
    } catch (error) {
      return { kind: 'error', message: message(error) };
    }
    const definition: ManagedDefinition = {
      provider: input.providerId,
      model: input.model || null,
      advanced_config: input.advancedConfig,
      instructions: input.instructions,
      auto_approve: input.autoApprove,
      directory: input.dir,
    };

    const created = await this.deps.create(workspaceId, {
      name: input.name,
      description: input.description,
      display_name: input.displayName,
      icon_url: input.iconUrl,
      controller_id: input.machineId,
      desired_state: 'running',
      definition,
    });
    if (created.kind === 'name-conflict') return { kind: 'name-conflict' };
    if (created.kind === 'refused') return { kind: 'error', message: created.message };
    this.deps.log.info('Created a managed agent', {
      switchAgentId: created.switchAgentId,
      controllerId: input.machineId,
    });
    return {
      kind: 'created',
      serverId: input.serverId,
      workspaceId,
      switchAgentId: created.switchAgentId,
    };
  }
}
