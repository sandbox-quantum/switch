import { randomUUID } from 'node:crypto';
import type { RepoAgentAttributes } from '@switch-console/core/agents/plugins';
import { locationManager } from '@main/core/locations/location-manager';
import { checkIsValidDirectory } from '@main/core/locations/path-utils';
import { ensureLocation, getLocationByHostDir } from '@main/core/locations/store';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { getServer } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';
import { agentAvatarUrlForName } from '@shared/core/agents/agent-avatar';
import type { AgentProviderConfig } from '@shared/core/agents/agent-provider-config';
import type { Agent } from '@shared/core/agents/agents';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { basenameFromAnyPath } from '@shared/path-name';
import { writeAgentConfigFile } from './agent-config-file';
import { syncAgentConfig } from './agent-config-sync';
import { foreignCredentialsOwner } from './agent-credentials-slot';
import { agentEvents } from './agent-events';
import { agentNameTaken } from './agent-name-taken';
import { resolveWorkspaceFsFor } from './agent-workspace-fs';
import { createAgent } from './createAgent';
import { knownAgentTypeForProvider } from './known-agent-type';
import { registerAgentIdentity } from './register-agent-identity';
import { reconcileAgentAutoSessionFromGateway } from './setAgentAutoSession';
import { writeNeutralAgentSettingsFs } from './write-switch-settings';

export type AddAgentParams = {
  id?: string;
  /** Where the agent runs: an `~/.ssh/config` Host alias, or null for this machine. */
  sshHost: string | null;
  /** The working directory (local absolute path, or the repo dir on the host). */
  dir: string;
  /** Display name for the location row when it is created (defaults to the dir basename). */
  locationName?: string;
  /** The agent's name — filesystem-safe; also its provider definition stem and
   * the `--agent <name>` value. */
  name: string;
  providerId: AgentProviderId;
  /** The registered Switch server to mint the identity on. */
  serverId: string;
  description: string;
  /** The icon picked in the create form. Null means the form offered no
   * choice, and the agent is registered with the avatar its name generates. */
  iconUrl: string | null;
  autoSession: boolean;
  autoApprove: boolean;
  /** The agent's system prompt, provider-agnostic. Rendered into whatever the
   * provider reads — a Claude Code subagent body, Codex's developer
   * instructions. Empty for an agent with none. */
  instructions: string;
  /** Provider-specific definition attributes (model, effort, tools, …), keyed
   * by the provider's attribute fields. `name`/`description` are set from the
   * params above, and the system prompt is `instructions`. */
  definitionAttributes: RepoAgentAttributes;
  /** Per-agent provider config folded into the agent's launch (Codex model /
   * effort / instructions). Distinct from `definitionAttributes`, which is the
   * repo-agent definition surface Codex does not use. */
  providerConfig?: AgentProviderConfig | null;
};

export type AddAgentResult =
  | { kind: 'created'; agent: Agent }
  | { kind: 'unauthenticated' }
  | { kind: 'name-conflict' }
  | { kind: 'credentials-conflict'; endpoint: string }
  | { kind: 'invalid-name'; message: string }
  | { kind: 'error'; message: string };

/**
 * Add a new agent to a location: mint its Switch identity on the gateway, write
 * its provider definition (`.claude/agents/<name>.md`) and its per-agent Switch
 * credentials (`.switch/agents/<name>.json`, keyed by name), then create the
 * agent row. Every Switch Console-managed agent is a flat, repository-defined agent
 * — for a provider that supports definitions it launches as `--agent <name>`
 * with its own identity; there is no "main" agent and no parent (CHOO-1440).
 *
 * Works for local and remote (SSH) run locations. The minted API token is
 * written to disk and never returned. A recoverable gateway failure is mapped to
 * a typed result the modal can act on; a filesystem failure after registration
 * throws (leaving the gateway agent, as the pre-existing provision path did).
 */
export async function addAgent(params: AddAgentParams): Promise<AddAgentResult> {
  if (params.sshHost === null && !checkIsValidDirectory(params.dir)) {
    return { kind: 'error', message: `Invalid directory: ${params.dir}` };
  }

  const server = await getServer(params.serverId);
  if (!server) return { kind: 'error', message: `No Switch server with id ${params.serverId}` };

  // Before minting an identity: the gateway's uniqueness check is scoped to the
  // Switch server, so it cannot see a name already taken in this directory. Two
  // same-named agents here would share one `.switch/agents/<name>.json`.
  const existingLocation = await getLocationByHostDir(params.sshHost, params.dir);
  if (existingLocation && (await agentNameTaken(existingLocation.id, params.name, null))) {
    return { kind: 'name-conflict' };
  }

  // And the check above only sees agents THIS install manages. A second Switch
  // Console on the same host, pointed at a different Switch server, has its own
  // database and its own agents in this same directory — so the only thing that
  // knows about its agent is the credentials file it left here (CHOO-1960).
  // Refuse before minting: the writer refuses too, but by then this agent's
  // token has been minted and is unrecoverable.
  const foreignEndpoint = await foreignCredentialsOwner(
    params.sshHost,
    params.dir,
    params.name,
    server.apiUrl
  );
  if (foreignEndpoint !== null) return { kind: 'credentials-conflict', endpoint: foreignEndpoint };

  const registered = await registerAgentIdentity(server, {
    name: params.name,
    description: params.description,
    repoDir: params.dir,
    autoSession: params.autoSession,
    agentType: knownAgentTypeForProvider(params.providerId),
    iconUrl: params.iconUrl ?? agentAvatarUrlForName(params.name),
  });
  if (registered.kind !== 'created') return registered;

  const behavior = getPlugin(params.providerId).behavior.repoAgents;
  const workspace = await resolveWorkspaceFsFor(params.sshHost, params.dir);
  try {
    // Writing the per-agent Switch credentials is unconditional core behavior for
    // every provider, keyed by the agent's `name` — the single key-space every
    // reader (launch path, auto-session watcher, notification poller) uses
    // (CHOO-1440). Providers with repo-agent definitions (Claude) layer their
    // on-disk definition on top; that's the only provider-specific extra.
    await writeNeutralAgentSettingsFs(workspace.fs, {
      slug: params.name,
      apiEndpoint: server.apiUrl,
      apiToken: registered.apiKey,
      agentId: registered.id,
    });
    // The config file is the agent's configuration; the provider's own file is
    // generated from it, here and on every later edit.
    await writeAgentConfigFile(workspace.fs, params.name, {
      instructions: params.instructions,
      settings: params.definitionAttributes,
    });
    await syncAgentConfig({
      workspaceFs: workspace.fs,
      repoAgents: behavior ?? null,
      name: params.name,
      description: params.description,
    });
  } finally {
    workspace.close();
  }

  const location = await ensureLocation({
    sshHost: params.sshHost,
    dir: params.dir,
    name: params.locationName ?? basenameFromAnyPath(params.dir) ?? params.name,
  });

  const agent = await createAgent({
    id: params.id ?? randomUUID(),
    locationId: location.id,
    name: params.name,
    providerId: params.providerId,
    switchAgentId: registered.id,
    apiEndpoint: server.apiUrl,
    serverId: params.serverId,
    autoApprove: params.autoApprove,
    providerConfig: params.providerConfig ?? null,
  });

  // Seed the local auto_session mirror + watcher from the gateway profile so an
  // agent registered with auto_session on starts watching now, without an
  // off→on toggle. Best-effort: a gateway hiccup must not fail creation.
  await reconcileAgentAutoSessionFromGateway(agent.id).catch((error) => {
    log.warn('addAgent: failed to reconcile auto_session for new agent', {
      agentId: agent.id,
      error: String(error),
    });
  });

  await locationManager.openLocation(location);
  agentEvents._emit('agent:created', agent);
  return { kind: 'created', agent };
}
