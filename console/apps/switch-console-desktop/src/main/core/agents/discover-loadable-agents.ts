import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import { fetchAgents, fetchMe } from '@main/core/switch-servers/gateway-client';
import { withWorkspaceSession, workspaceServer } from '@main/core/workspaces/workspace-session';
import { log } from '@main/lib/logger';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { sameApiEndpoint } from '@shared/core/switch-servers/switch-servers';
import type { DiscoveredConfiguredAgent, ProviderSource } from './discover-configured-agents';
import { discoverConfiguredAgents } from './discover-configured-agents';

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
};

export type DiscoverLoadableAgentsParams = {
  sshHost: string;
  workspaceId: string;
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
  const server = await workspaceServer(params.workspaceId);

  // Key: "dir\0name" → LoadableAgent. Server entries inserted first win.
  const seen = new Map<string, LoadableAgent>();

  // --- Source 1: Server-assisted discovery ---
  try {
    // Leased together: `GET /agents` answers for the selected tenant, and the
    // owner marks below are only meaningful against the same one. The on-host
    // scans that follow are SSH and need no session, so the lease ends here
    // rather than being held across them.
    const { remoteAgents, me } = await withWorkspaceSession(params.workspaceId, async () => ({
      remoteAgents: await fetchAgents(server),
      // Marks rows the signed-in user owns; an auth failure degrades to not-owner.
      me: await fetchMe(server).catch(() => null),
    }));

    // Collect distinct repo_dirs from agents whose known_agent_options carry one.
    type ServerAgentInfo = {
      ownerName: string | null;
      ownerId: string | null;
      description: string | null;
    };
    const dirOwners = new Map<string, Map<string, ServerAgentInfo>>();
    for (const agent of remoteAgents) {
      const repoDir =
        agent.knownAgentOptions &&
        typeof agent.knownAgentOptions === 'object' &&
        typeof (agent.knownAgentOptions as Record<string, unknown>).repo_dir === 'string'
          ? ((agent.knownAgentOptions as Record<string, unknown>).repo_dir as string)
          : null;
      if (!repoDir) continue;

      if (!dirOwners.has(repoDir)) dirOwners.set(repoDir, new Map());
      dirOwners.get(repoDir)!.set(agent.name, {
        ownerName: agent.ownerName,
        ownerId: agent.ownerId,
        description: agent.description ?? null,
      });
    }

    for (const [dir, nameOwners] of dirOwners) {
      try {
        const discovered = await discoverConfiguredAgents({
          sshHost: params.sshHost,
          dir,
          serverId: server.id,
        });
        for (const agent of discovered) {
          const key = `${dir}\0${agent.name}`;
          const info = nameOwners.get(agent.name) ?? null;
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
          });
        }
      } catch (error) {
        log.warn('discoverLoadableAgentsOnHost: server-assisted dir scan failed', {
          dir,
          sshHost: params.sshHost,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    log.warn('discoverLoadableAgentsOnHost: server-assisted discovery failed', {
      workspaceId: params.workspaceId,
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
          serverId: server.id,
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
  workspaceId: string;
}): Promise<{ agents: LoadableAgent[]; serverApiUrl: string }> {
  // The server only, with no lease: this path makes no gateway call — the scan
  // is on-host and the server is here for its API URL.
  const server = await workspaceServer(params.workspaceId);

  const discovered = await discoverConfiguredAgents({
    sshHost: params.sshHost,
    dir: params.dir,
    serverId: server.id,
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
  }));
  return { agents, serverApiUrl: server.apiUrl };
}
