import { randomUUID } from 'node:crypto';
import type { RepoAgentAttributes } from '@switchdash/core/agents/plugins';
import { locationManager } from '@main/core/locations/location-manager';
import { checkIsValidDirectory } from '@main/core/locations/path-utils';
import { ensureLocation } from '@main/core/locations/store';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { getServer } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { basenameFromAnyPath } from '@shared/path-name';
import { agentEvents } from './agent-events';
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
  autoSession: boolean;
  autoApprove: boolean;
  /** Provider-specific definition attributes (model, effort, tools, prompt, …),
   * keyed by the provider's attribute fields. `name`/`description` are set from
   * the params above. */
  definitionAttributes: RepoAgentAttributes;
};

export type AddAgentResult =
  | { kind: 'created'; agent: Agent }
  | { kind: 'unauthenticated' }
  | { kind: 'name-conflict' }
  | { kind: 'invalid-name'; message: string }
  | { kind: 'error'; message: string };

/**
 * Add a new agent to a location: mint its Switch identity on the gateway, write
 * its provider definition (`.claude/agents/<name>.md`) and its per-agent Switch
 * credentials (`.switch/agents/<name>.json`, keyed by name), then create the
 * agent row. Every switchdash-managed agent is a flat, repository-defined agent
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

  const registered = await registerAgentIdentity(server, {
    name: params.name,
    description: params.description,
    repoDir: params.dir,
    autoSession: params.autoSession,
    agentType: knownAgentTypeForProvider(params.providerId),
  });
  if (registered.kind !== 'created') return registered;

  // Generated up front so the per-agent credentials file can be keyed by it
  // below — the launch path reads `agentSettingsPath(sessionPath, session.agentId)`.
  const localAgentId = params.id ?? randomUUID();

  const behavior = getPlugin(params.providerId).behavior.repoAgents;
  const workspace = await resolveWorkspaceFsFor(params.sshHost, params.dir);
  try {
    if (behavior) {
      await behavior.writeDefinition(workspace.fs, {
        ...params.definitionAttributes,
        name: params.name,
        description: params.description,
      });
      await behavior.writeCredentials(workspace.fs, {
        agentName: params.name,
        apiEndpoint: server.apiUrl,
        apiToken: registered.apiKey,
        agentId: registered.id,
      });
    } else {
      // Two credential-keying conventions exist and the readers (auto-session
      // watcher + notification poller) try both via a fallback chain:
      //   - behavior providers (Claude) key by agent NAME (writeCredentials above)
      //   - non-behavior providers (Codex) key by agent ID (this branch)
      // Providers without repo-agent definitions (e.g. Codex) have no
      // `writeCredentials` hook, so their Switch credentials would never land on
      // disk — leaving the session with no `SWITCH_*` to inject and the
      // MCP-based Switch setup a no-op. Write the provider-neutral per-agent
      // file directly from the freshly-minted token, keyed by the agent id the
      // launch path reads (CHOO-1436).
      await writeNeutralAgentSettingsFs(workspace.fs, {
        slug: localAgentId,
        apiEndpoint: server.apiUrl,
        apiToken: registered.apiKey,
        agentId: registered.id,
      });
    }
  } finally {
    workspace.close();
  }

  const location = await ensureLocation({
    sshHost: params.sshHost,
    dir: params.dir,
    name: params.locationName ?? basenameFromAnyPath(params.dir) ?? params.name,
  });

  const agent = await createAgent({
    id: localAgentId,
    locationId: location.id,
    name: params.name,
    providerId: params.providerId,
    switchAgentId: registered.id,
    apiEndpoint: server.apiUrl,
    serverId: params.serverId,
    autoApprove: params.autoApprove,
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
