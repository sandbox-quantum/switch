import type { PluginFs } from '@switch-console/core/agents/plugins';
import { getLocationByHostDir } from '@main/core/locations/store';
import { listPlugins } from '@main/core/providers/plugin-registry';
import { log } from '@main/lib/logger';
import {
  isValidProviderId,
  type AgentProviderId,
} from '@shared/core/providers/agent-provider-registry';
import type { AgentLaunchSpec } from '../../../sidecar/agent-launch-spec';
import { sidecarLaunchSpecRelPath } from '../../../sidecar/sidecar-paths';
import { resolveWorkspaceFsFor } from './agent-workspace-fs';
import { getLocationAgentsOnServer } from './getAgents';
import { SWITCH_AGENTS_DIR_RELATIVE } from './switch-settings-paths';

/** How an agent's provider was inferred, so the UI can say whether to trust it. */
export type ProviderSource = 'launch-spec' | 'definition' | 'unknown';

/**
 * An agent already configured in a working directory, found by its
 * provider-neutral Switch credentials rather than by any provider's definition
 * format.
 */
export type DiscoveredConfiguredAgent = {
  /** The `.switch/agents/<name>.json` filename stem — the key every reader and
   * writer of the credentials uses, and the agent's name. */
  name: string;
  switchAgentId: string;
  apiEndpoint: string;
  /** Best-effort: null when nothing on disk names a provider. */
  providerId: AgentProviderId | null;
  providerSource: ProviderSource;
  /** Whether this Switch Console already has a row for the name at this location, on
   * the server being onboarded to. */
  alreadyAgent: boolean;
};

/**
 * The Switch identity in a credentials file, without its token.
 *
 * `SWITCH_API_TOKEN` is present in the file and is deliberately never read: an
 * attaching Switch Console needs no secret, because the launch path reads the token
 * straight from disk at spawn time. Keeping it unread is what makes attaching to
 * another install's agent a non-destructive, credential-free operation.
 */
type CredentialIdentity = { switchAgentId: string; apiEndpoint: string };

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseCredentialIdentity(raw: string | null, name: string): CredentialIdentity | null {
  if (raw === null) return null;
  let env: Record<string, unknown> | undefined;
  try {
    env = (JSON.parse(raw) as { env?: Record<string, unknown> })?.env;
  } catch (error) {
    log.warn('discoverConfiguredAgents: unparseable credentials file', {
      name,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (!env) return null;

  const switchAgentId = asNonEmptyString(env.SWITCH_AGENT_ID);
  const apiEndpoint = asNonEmptyString(env.SWITCH_API_ENDPOINT);
  if (!switchAgentId || !apiEndpoint) return null;
  return { switchAgentId, apiEndpoint };
}

/**
 * The provider named by the agent's sidecar launch spec — what actually spawns
 * its sessions on a remote host, so the most authoritative signal available.
 * Absent for an agent that has never run remotely.
 */
async function providerFromLaunchSpec(
  workspaceFs: PluginFs,
  name: string
): Promise<AgentProviderId | null> {
  const raw = await workspaceFs.read(sidecarLaunchSpecRelPath(name));
  if (raw === null) return null;
  try {
    const spec = JSON.parse(raw) as Partial<AgentLaunchSpec>;
    return isValidProviderId(spec.providerId) ? spec.providerId : null;
  } catch (error) {
    log.warn('discoverConfiguredAgents: unparseable launch spec', {
      name,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Definition names per provider, for the providers that have a definition
 * concept at all. Built once per scan: each provider answers with its own
 * discovery rather than this module hardcoding any provider's on-disk layout.
 */
async function definitionOwners(workspaceFs: PluginFs): Promise<Map<string, AgentProviderId>> {
  const owners = new Map<string, AgentProviderId>();
  for (const plugin of listPlugins()) {
    const behavior = plugin.behavior.repoAgents;
    if (!behavior) continue;
    try {
      for (const def of await behavior.discoverDefinitions(workspaceFs)) {
        if (!owners.has(def.name) && isValidProviderId(plugin.metadata.id)) {
          owners.set(def.name, plugin.metadata.id);
        }
      }
    } catch (error) {
      log.warn('discoverConfiguredAgents: provider definition scan failed', {
        providerId: plugin.metadata.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return owners;
}

/**
 * Read-only scan of a working directory for agents already configured there,
 * keyed on the provider-neutral `.switch/agents/<name>.json` credentials every
 * provider writes at create time (CHOO-1937).
 *
 * This is the counterpart to `discoverLocationAgents`, and answers a different
 * question. That one asks a provider which of *its* definitions in the directory
 * could become an agent — a Claude-only answer today, since Claude is the only
 * provider with a definition concept. This one asks which agents already *are*
 * configured here, whoever set them up and whichever provider runs them, so an
 * agent someone else onboarded on a shared host is visible to every Switch Console
 * that can reach the directory.
 *
 * Deliberately pure disk IO: it does not verify the identities against a Switch
 * server. That check needs a server the caller has chosen and belongs to the
 * attach path, which fails loudly on a missing identity rather than papering
 * over it here.
 *
 * Works for local and remote (SSH) directories.
 */
export async function discoverConfiguredAgents(params: {
  sshHost: string | null;
  dir: string;
  /** The Switch server being onboarded to — what `alreadyAgent` is judged against.
   * A directory can hold agents for several servers, so the same name can be
   * attached here already and still be attachable to another (CHOO-2044). */
  serverId: string;
}): Promise<DiscoveredConfiguredAgent[]> {
  const location = await getLocationByHostDir(params.sshHost, params.dir);
  const existing = location
    ? new Set((await getLocationAgentsOnServer(location.id, params.serverId)).map((a) => a.name))
    : new Set<string>();

  const workspace = await resolveWorkspaceFsFor(params.sshHost, params.dir);
  try {
    const names = (await workspace.fs.list(SWITCH_AGENTS_DIR_RELATIVE))
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.slice(0, -'.json'.length))
      .filter((name) => name.length > 0)
      .sort((a, b) => a.localeCompare(b));
    if (names.length === 0) return [];

    const owners = await definitionOwners(workspace.fs);

    const discovered: DiscoveredConfiguredAgent[] = [];
    for (const name of names) {
      const identity = parseCredentialIdentity(
        await workspace.fs.read(`${SWITCH_AGENTS_DIR_RELATIVE}/${name}.json`),
        name
      );
      if (!identity) continue;

      const fromSpec = await providerFromLaunchSpec(workspace.fs, name);
      const fromDefinition = owners.get(name) ?? null;
      const providerId = fromSpec ?? fromDefinition;
      const providerSource: ProviderSource = fromSpec
        ? 'launch-spec'
        : fromDefinition
          ? 'definition'
          : 'unknown';

      discovered.push({
        name,
        switchAgentId: identity.switchAgentId,
        apiEndpoint: identity.apiEndpoint,
        providerId,
        providerSource,
        alreadyAgent: existing.has(name),
      });
    }
    return discovered;
  } finally {
    workspace.close();
  }
}
