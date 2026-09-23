import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import { fetchAgents, fetchMe } from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { sameApiEndpoint } from '@shared/core/switch-servers/switch-servers';
import type { RemoteAgentSummary, SwitchServer } from '@shared/core/switch-servers/switch-servers';
import type { DiscoveredConfiguredAgent, ProviderSource } from './discover-configured-agents';
import { discoverConfiguredAgents } from './discover-configured-agents';
import { getAgents } from './getAgents';
import { providerForKnownAgentType } from './known-agent-type';
import { accountOwning, type DirAccess, type HostHome, repoDirOf } from './observed-agent-paths';
import { hostHomes, probeDirAccess } from './observed-agents';

/**
 * An agent found on a remote host that can be loaded into this Console.
 *
 * Merges server-assisted discovery (which carries owner attribution) with a
 * bounded on-host scan (which catches unregistered agents). Server-attributed
 * entries win on dedup so attribution is preserved.
 */
export type LoadableAgent = {
  name: string;
  dir: string;
  switchAgentId: string;
  apiEndpoint: string;
  providerId: AgentProviderId | null;
  providerSource: ProviderSource;
  /** Whether this Console already has a row for this agent. */
  alreadyAgent: boolean;
  /** The agent's owner on the server, when known via server-assisted discovery. */
  ownerName: string | null;
  /** True when the signed-in user is the agent's owner on the server. */
  viewerIsOwner: boolean;
  /** The agent's server-side description, when known via server-assisted discovery. */
  description: string | null;
  /** The source that found this agent. */
  source: 'server' | 'scan';
  /** True when the on-disk endpoint does not match the server's URL. */
  endpointMismatch: boolean;
  /** When set, the agent cannot be loaded and this is the human-readable reason. */
  blockedReason: string | null;
  /**
   * True for an agent another account runs on this host (CHOO-2893): its
   * directory cannot be read from here, so it is followed rather than loaded —
   * its sessions through the server, nothing run on the host.
   */
  observed: boolean;
  /** The account that runs an observed agent, when it could be told. */
  observedOwner: string | null;
};

export type DiscoverLoadableAgentsParams = {
  sshHost: string;
  serverId: string;
  /** When true, run a depth-limited `find` over `$HOME` in addition to the
   *  cheap server-assisted discovery. Off by default — the walk can be slow
   *  on large VMs. */
  includeHomeScan?: boolean;
};

export type DiscoverLoadableAgentsResult = {
  agents: LoadableAgent[];
  /** The target server's API URL, for rendering endpoint mismatches legibly. */
  serverApiUrl: string;
};

/**
 * Discover agents on a remote host that can be loaded into this Console,
 * merging two sources and deduping by `(dir, name)`.
 *
 * 1. **Server-assisted:** `GET /agents` for the deployment's agents with
 *    `repo_dir`; confirm each dir on-host via `discoverConfiguredAgents`.
 * 2. **Bounded `$HOME` scan:** depth-limited `find` under the host's `$HOME`
 *    for dirs holding `.switch/agents/*.json`.
 *
 * Server-attributed entries win on dedup so owner attribution is preserved.
 */
export async function discoverLoadableAgentsOnHost(
  params: DiscoverLoadableAgentsParams
): Promise<DiscoverLoadableAgentsResult> {
  const server = await getServer(params.serverId);
  if (!server) throw new Error(`No Switch server with id ${params.serverId}`);

  // Key: "dir\0name" → LoadableAgent. Server entries inserted first win.
  const seen = new Map<string, LoadableAgent>();

  // --- Source 1: Server-assisted discovery ---
  try {
    const remoteAgents = await fetchAgents(server);
    // Marks rows the signed-in user owns; an auth failure degrades to not-owner.
    const me = await fetchMe(server).catch(() => null);

    const byDir = new Map<string, RemoteAgentSummary[]>();
    for (const agent of remoteAgents) {
      const repoDir = repoDirOf(agent);
      if (!repoDir) continue;
      byDir.set(repoDir, [...(byDir.get(repoDir) ?? []), agent]);
    }

    // How this account can reach each directory decides how its agents come
    // in: loaded from disk where it can read them, followed from the server
    // where another account holds them (CHOO-2893), not at all where the
    // directory is not on this host.
    const access = await probeDirAccess(params.sshHost, [...byDir.keys()]).catch((error) => {
      log.warn('discoverLoadableAgentsOnHost: could not check directory access', {
        sshHost: params.sshHost,
        error: error instanceof Error ? error.message : String(error),
      });
      return new Map<string, DirAccess>();
    });
    const held = new Set(
      (await getAgents())
        .filter((agent) => agent.serverId === server.id && agent.switchAgentId)
        .map((agent) => agent.switchAgentId)
    );
    let homes: HostHome[] | null = null;
    const observe = async (dir: string, agents: RemoteAgentSummary[]): Promise<void> => {
      homes ??= await hostHomes(params.sshHost);
      const owner = accountOwning(dir, homes);
      for (const agent of agents) {
        seen.set(`${dir}\0${agent.name}`, observedCandidate(agent, dir, owner, server, me, held));
      }
    };

    for (const [dir, agents] of byDir) {
      const reach = access.get(dir) ?? 'readable';
      if (reach === 'missing') {
        log.info('discoverLoadableAgentsOnHost: agent directory is not on this host', {
          dir,
          sshHost: params.sshHost,
        });
        continue;
      }
      if (reach === 'denied') {
        await observe(dir, agents);
        continue;
      }
      const owners = new Map(agents.map((agent) => [agent.name, agent]));
      try {
        const discovered = await discoverConfiguredAgents({
          sshHost: params.sshHost,
          dir,
          serverId: params.serverId,
        });
        for (const agent of discovered) {
          const key = `${dir}\0${agent.name}`;
          const info = owners.get(agent.name) ?? null;
          seen.set(key, {
            name: agent.name,
            dir,
            switchAgentId: agent.switchAgentId,
            apiEndpoint: agent.apiEndpoint,
            providerId: agent.providerId,
            providerSource: agent.providerSource,
            alreadyAgent: agent.alreadyAgent,
            ownerName: info?.ownerName ?? null,
            viewerIsOwner: !!(me && info?.ownerId && info.ownerId === me.id),
            description: info?.description ?? null,
            source: 'server',
            endpointMismatch: !sameApiEndpoint(agent.apiEndpoint, server.apiUrl),
            blockedReason: blockedReasonFor(agent, server.apiUrl),
            observed: false,
            observedOwner: null,
          });
        }
      } catch (error) {
        // The directory is readable but its agents' files are not: they are
        // still another account's, so they are followed rather than lost.
        log.warn('discoverLoadableAgentsOnHost: server-assisted dir scan failed; following', {
          dir,
          sshHost: params.sshHost,
          error: error instanceof Error ? error.message : String(error),
        });
        await observe(dir, agents);
      }
    }
  } catch (error) {
    log.warn('discoverLoadableAgentsOnHost: server-assisted discovery failed', {
      serverId: params.serverId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // --- Source 2: Bounded $HOME scan (opt-in) ---
  if (!params.includeHomeScan) return { agents: [...seen.values()], serverApiUrl: server.apiUrl };
  try {
    const scannedDirs = await findSwitchAgentDirsOnHost(params.sshHost);
    for (const dir of scannedDirs) {
      try {
        const discovered = await discoverConfiguredAgents({
          sshHost: params.sshHost,
          dir,
          serverId: params.serverId,
        });
        for (const agent of discovered) {
          const key = `${dir}\0${agent.name}`;
          if (!seen.has(key)) {
            seen.set(key, {
              name: agent.name,
              dir,
              switchAgentId: agent.switchAgentId,
              apiEndpoint: agent.apiEndpoint,
              providerId: agent.providerId,
              providerSource: agent.providerSource,
              alreadyAgent: agent.alreadyAgent,
              ownerName: null,
              viewerIsOwner: false,
              description: null,
              source: 'scan',
              endpointMismatch: !sameApiEndpoint(agent.apiEndpoint, server.apiUrl),
              blockedReason: blockedReasonFor(agent, server.apiUrl),
              observed: false,
              observedOwner: null,
            });
          }
        }
      } catch (error) {
        log.warn('discoverLoadableAgentsOnHost: scan dir discovery failed', {
          dir,
          sshHost: params.sshHost,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    log.warn('discoverLoadableAgentsOnHost: bounded scan failed', {
      sshHost: params.sshHost,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { agents: [...seen.values()], serverApiUrl: server.apiUrl };
}

/** An agent another account runs here, as the server describes it. */
function observedCandidate(
  agent: RemoteAgentSummary,
  dir: string,
  owner: string | null,
  server: SwitchServer,
  me: { id: string } | null,
  held: Set<string | null>
): LoadableAgent {
  const providerId = providerForKnownAgentType(agent.knownAgentType);
  const alreadyAgent = held.has(agent.id);
  return {
    name: agent.name,
    dir,
    switchAgentId: agent.id,
    apiEndpoint: server.apiUrl,
    providerId,
    providerSource: providerId ? 'server' : 'unknown',
    alreadyAgent,
    ownerName: agent.ownerName,
    viewerIsOwner: !!(me && agent.ownerId && agent.ownerId === me.id),
    description: agent.description ?? null,
    source: 'server',
    endpointMismatch: false,
    blockedReason: alreadyAgent
      ? 'Already loaded in this Console'
      : providerId
        ? null
        : `A ${agent.knownAgentType ?? 'untyped'} agent, which this Switch Console cannot show`,
    observed: true,
    observedOwner: owner,
  };
}

function blockedReasonFor(agent: DiscoveredConfiguredAgent, serverApiUrl: string): string | null {
  if (agent.alreadyAgent) return 'Already loaded in this Console';
  if (!sameApiEndpoint(agent.apiEndpoint, serverApiUrl))
    return 'Endpoint does not match this server';
  return null;
}

/**
 * Bounded depth-limited scan of `$HOME` on a remote host for directories
 * containing `.switch/agents/*.json`. Prunes `node_modules` and every hidden
 * directory except `.switch` itself — dot-trees like `.cargo`, `.npm` or
 * `.vscode-server` hold hundreds of thousands of entries on a dev box and can
 * never contain a working directory we would surface.
 *
 * Returns the parent working directories (the dirs that contain `.switch/`),
 * not the `.switch/agents/` paths themselves.
 */
async function findSwitchAgentDirsOnHost(sshHost: string): Promise<string[]> {
  const proxy = await ensureSshConnected(sshConnectionIdForHost(sshHost), sshHost);
  const ctx = new SshExecutionContext(proxy);
  let result: { stdout: string };
  try {
    result = await ctx.exec('sh', [
      '-c',
      [
        'find "$HOME" -maxdepth 6',
        '-type d \\( -name node_modules -o \\( -name ".*" ! -name .switch \\) \\) -prune',
        '-o -type f -path "*/.switch/agents/*.json" -print',
        '2>/dev/null',
        '| sed "s|/\\.switch/agents/.*||"',
        '| sort -u',
      ].join(' '),
    ]);
  } catch (error) {
    // Disclosed fallback: an exec failure must not read as "empty host", so
    // leave a trace even though discovery continues with the server source.
    log.warn('findSwitchAgentDirsOnHost: $HOME scan failed', {
      sshHost,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  return result.stdout
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);
}

/**
 * Discover agents in a single manually-specified directory — the "scan a
 * directory" fallback. A thin wrapper that calls the existing per-dir scan
 * and attaches the same metadata shape as the merged discovery.
 */
export async function discoverLoadableAgentsInDir(params: {
  sshHost: string;
  dir: string;
  serverId: string;
}): Promise<{ agents: LoadableAgent[]; serverApiUrl: string }> {
  const server = await getServer(params.serverId);
  if (!server) throw new Error(`No Switch server with id ${params.serverId}`);

  const discovered = await discoverConfiguredAgents({
    sshHost: params.sshHost,
    dir: params.dir,
    serverId: params.serverId,
  });

  const agents = discovered.map((agent) => ({
    name: agent.name,
    dir: params.dir,
    switchAgentId: agent.switchAgentId,
    apiEndpoint: agent.apiEndpoint,
    providerId: agent.providerId,
    providerSource: agent.providerSource,
    alreadyAgent: agent.alreadyAgent,
    ownerName: null,
    viewerIsOwner: false,
    description: null,
    source: 'scan' as const,
    endpointMismatch: !sameApiEndpoint(agent.apiEndpoint, server.apiUrl),
    blockedReason: blockedReasonFor(agent, server.apiUrl),
    observed: false,
    observedOwner: null,
  }));
  return { agents, serverApiUrl: server.apiUrl };
}
