import type { CLIAgentPluginProvider } from '@switch-console/core/agents/plugins';
import { resolveCommandPath } from '@switch-console/core/deps/runtime';
import { providerAdapterRegistry } from '@main/core/agent-runtime/impl/provider-adapter-registry';
import { getRemoteDependencyManager } from '@main/core/dependencies/remote-dependency-manager';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { listPlugins } from '@main/core/providers/plugin-registry';
import type { AgentTypeAvailability } from '@shared/core/agent-types/agent-type-availability';

/** What to tell someone to install, where the product name alone would be ambiguous. */
const CLI_LABELS: Record<string, string> = {
  cursor: 'Cursor CLI',
  antigravity: 'Antigravity ACP',
};

function cliLabel(plugin: CLIAgentPluginProvider): string {
  return CLI_LABELS[plugin.metadata.id] ?? plugin.metadata.name;
}

function available(agentId: string): AgentTypeAvailability {
  return { agentId, available: true, blockedReason: null, blockedKind: null };
}

/**
 * Every agent type on this machine, usable or not. A type is usable when this
 * platform can host SDK sessions, Switch Console has a session adapter for it,
 * and its CLI is on this machine's PATH.
 */
export async function listLocalAgentTypeAvailability(): Promise<AgentTypeAvailability[]> {
  const ctx = new LocalExecutionContext();
  const availability: AgentTypeAvailability[] = [];
  for (const plugin of listPlugins()) {
    const agentId = plugin.metadata.id;
    if (process.platform === 'win32' || !providerAdapterRegistry.supports(agentId)) {
      availability.push({
        agentId,
        available: false,
        blockedReason:
          process.platform === 'win32'
            ? 'SDK sessions require a POSIX SSH execution host.'
            : 'This provider has no SDK session adapter.',
        blockedKind: 'unsupported',
      });
      continue;
    }
    let installed = false;
    for (const binary of plugin.capabilities.hostDependency.binaryNames) {
      if (await resolveCommandPath(binary, ctx)) {
        installed = true;
        break;
      }
    }
    availability.push(
      installed
        ? available(agentId)
        : {
            agentId,
            available: false,
            blockedReason: `Install ${cliLabel(plugin)} on this computer.`,
            blockedKind: 'not-installed',
          }
    );
  }
  return availability;
}

/** Every agent type on a remote host, usable or not, judged by probing its CLI there. */
export async function listRemoteAgentTypeAvailability(
  sshHost: string
): Promise<AgentTypeAvailability[]> {
  const manager = await getRemoteDependencyManager(sshHost);
  const availability: AgentTypeAvailability[] = [];
  for (const plugin of listPlugins()) {
    const agentId = plugin.metadata.id;
    if (!providerAdapterRegistry.supports(agentId)) {
      availability.push({
        agentId,
        available: false,
        blockedReason: `Switch Console cannot manage this agent type on ${sshHost}.`,
        blockedKind: 'unsupported',
      });
      continue;
    }
    const cli = await manager.probe(agentId);
    availability.push(
      cli.status === 'available'
        ? available(agentId)
        : cli.status === 'missing'
          ? {
              agentId,
              available: false,
              blockedReason: `Install ${cliLabel(plugin)} on ${sshHost}.`,
              blockedKind: 'not-installed',
            }
          : {
              agentId,
              available: false,
              blockedReason: `Could not verify this CLI on ${sshHost}. Recheck the host setup.`,
              blockedKind: 'unknown',
            }
    );
  }
  return availability;
}
