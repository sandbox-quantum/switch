import type { RepoAgentField } from '@switch-console/core/agents/plugins';
import type { AdvancedConfigValue } from '@switch-console/plugins/agents';

/**
 * An agent whose configuration lives on its Switch server: what it is, the
 * machine it runs on, and how it is doing there. The server is the source of
 * truth; Console keeps no copy.
 */
export type ManagedAgentView = {
  serverId: string;
  /** The workspace it is registered in, for its server-held settings such as who can address it. */
  workspaceId: string;
  /** The Switch agent id. */
  agentId: string;
  name: string;
  displayName: string | null;
  iconUrl: string | null;
  description: string;
  /** The machine it is placed on, or null when it is placed on none. */
  machine: ManagedMachine | null;
  desiredState: 'running' | 'stopped';
  revision: number;
  definition: {
    provider: string;
    model: string | null;
    /** The provider's advanced configuration, keyed by its field keys; unset fields are absent. */
    advancedConfig: Record<string, AdvancedConfigValue>;
    instructions: string;
    autoApprove: boolean;
    /**
     * The working directory on its machine. The server fills in the machine's
     * workspace for the agent; null only when the machine has not said where that is.
     */
    directory: string | null;
    isolation: 'shared' | 'isolated';
  };
  /** What its machine last reported for it, or null before it has. */
  status: {
    process: string;
    attached: boolean;
    reason: string | null;
    detail: string | null;
    /** The absolute working directory it runs in; null until the machine resolved one. */
    directory: string | null;
  } | null;
};

/** A machine a managed agent can be placed on. */
export type ManagedMachine = {
  id: string;
  name: string;
  kind: string;
  state: 'online' | 'offline' | 'unknown' | 'revoked';
};

/** A provider on a machine, as the machine last reported it. */
export type MachineProvider = {
  /** The Switch definition provider id (`claude`, `codex`, …). */
  provider: string;
  /** Installed and logged in. */
  ready: boolean;
  /** Why it is not ready, in a few words; null when it is. */
  problem: string | null;
};

/**
 * A provider login to give a machine: a key or token typed in, or this
 * computer's own sign-in for the provider, read from its file.
 */
export type MachineLoginInput =
  | { source: 'typed'; kind: 'api-key' | 'setup-token'; credential: string }
  | { source: 'this-computer' };

/** How giving a machine a login went: still being taken up, taken up, or why not. */
export type MachineLoginOutcome =
  | { state: 'pending' }
  | { state: 'succeeded' }
  | { state: 'failed'; code: string; message: string };

/** What a machine is to this Console: this computer, one of its SSH hosts, or neither. */
export type MachineLocal = { kind: 'this-computer' } | { kind: 'ssh-host'; sshHost: string } | null;

/** One of the owner's machines on a server, with what it last reported about its providers. */
export type OwnedMachine = ManagedMachine & {
  /** Empty before the machine has reported. */
  providers: MachineProvider[];
  /** It can be given a provider login sealed to its key: its controller registered one. */
  acceptsLogins: boolean;
  /** The owner's Switch cloud machine, offered as "Switch cloud" rather than by name. */
  cloud: boolean;
  /**
   * Where the machine makes agents' workspaces (an agent's is `<workspacesDir>/<name>`);
   * null before it has said.
   */
  workspacesDir: string | null;
  local: MachineLocal;
};

/** The settings a managed agent's page changes; a field left out stays as the server holds it. */
export type ManagedAgentChanges = {
  definition: Partial<ManagedAgentView['definition']>;
  /** Moves it to another of the owner's machines. */
  machineId?: string;
};

/**
 * One field of a provider's advanced configuration, as the server's schema
 * serves it: the shape of Console's own field descriptors, so the same form
 * renders either.
 */
export type AdvancedConfigField = Pick<
  RepoAgentField,
  'key' | 'label' | 'type' | 'help' | 'placeholder' | 'options' | 'catalogue'
>;
