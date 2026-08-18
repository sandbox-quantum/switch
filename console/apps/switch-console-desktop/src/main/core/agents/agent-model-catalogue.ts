import type { LaunchProfileModel } from '@switch-console/core/agents/plugins';
import { isTransportFailure } from '@switch-console/core/exec';
import { resolveAgentExecutable } from '@main/core/agent-runtime/impl/resolve-agent-executable';
import { localDependencyManager } from '@main/core/dependencies/dependency-managers';
import { hostDependencyStore } from '@main/core/dependencies/host-dependency-store';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { SshExecutionContext } from '@main/core/execution-context/ssh-execution-context';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { locationTransport } from '@main/core/locations/location-transport';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import { log } from '@main/lib/logger';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

/**
 * The models a host offers, or why we could not find out.
 *
 * Two outcomes rather than an empty list, because they mean opposite things to
 * the form: `unavailable` leaves a model field as plain text and says why, while
 * an empty `available` would flag everything the user types as wrong. The
 * provider CLI not being installed on that host is the common case and is not an
 * error worth a dialog — it is a reason the field cannot check itself.
 */
export type AgentModelCatalogue =
  | { kind: 'available'; models: LaunchProfileModel[] }
  | { kind: 'unavailable'; reason: string };

/**
 * Ask a host which models it offers for a provider, and what reasoning variants
 * each accepts, for the advanced-configuration fields that declare a `catalogue`
 * binding.
 *
 * Keyed on the host rather than on an agent so the create-agent form can ask
 * before the agent exists, and so the answer comes from the machine that decides
 * it: a local agent and a remote one do not offer the same models, and a
 * locally-served model exists on exactly one of them.
 *
 * Never throws. Every failure becomes a reason the form shows.
 */
export async function getAgentModelCatalogue(params: {
  providerId: AgentProviderId;
  /** The location's SSH alias, or null for this machine. */
  sshHost: string | null;
  dir: string;
}): Promise<AgentModelCatalogue> {
  const plugin = getPlugin(params.providerId);
  const launchProfileModels = plugin.behavior.mcp?.launchProfileModels;
  if (!launchProfileModels) {
    return {
      kind: 'unavailable',
      reason: `${plugin.metadata.name} does not publish a model list.`,
    };
  }

  let ctx: IExecutionContext | null = null;
  try {
    const host = await resolveHost(params.sshHost, params.dir);
    ctx = host.ctx;

    const cli = await resolveAgentExecutable({
      providerId: params.providerId,
      binaryName: plugin.capabilities.hostDependency.binaryNames[0] ?? params.providerId,
      ctx: host.ctx,
      hostDependencyStore,
      // Skips a `which` when the local dependency probe already resolved it.
      // Absent for a remote host, whose probe is a different manager.
      cachedStatePath:
        params.sshHost === null
          ? localDependencyManager.get(params.providerId as never)?.path
          : undefined,
      connectionId: host.connectionId,
    });

    // The resolved binary replaces the one the provider named, so a user who
    // pinned a particular install is asked about that one rather than whatever
    // happens to be first on PATH.
    const execAt = host.ctx;
    const models = await launchProfileModels(async (_command, args) => execAt.exec(cli, args));
    return { kind: 'available', models };
  } catch (error) {
    const reason = describe(error, plugin.metadata.name, params.sshHost);
    log.info('getAgentModelCatalogue: could not read the host model catalogue', {
      providerId: params.providerId,
      sshHost: params.sshHost,
      reason,
    });
    return { kind: 'unavailable', reason };
  } finally {
    ctx?.dispose();
  }
}

/**
 * Say what went wrong in terms the person filling in the form can act on.
 *
 * A transport failure and a command failure look the same to a caller but call
 * for opposite responses — fix the connection, or install the CLI — so they are
 * distinguished rather than both reported as "could not read models".
 */
function describe(error: unknown, providerName: string, sshHost: string | null): string {
  if (isTransportFailure(error)) {
    return `Couldn't reach ${sshHost ?? 'this machine'}.`;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `Couldn't ask ${providerName} on ${sshHost ?? 'this machine'} for its models: ${detail}`;
}

/** An execution context on the machine a location lives on, local or remote. */
async function resolveHost(
  sshHost: string | null,
  dir: string
): Promise<{ ctx: IExecutionContext; connectionId?: string }> {
  const transport = locationTransport({ sshHost, dir });
  if (transport.kind === 'local') {
    return { ctx: new LocalExecutionContext({ root: dir }) };
  }

  const proxy = await ensureSshConnected(transport.connectionId, transport.host);
  return {
    ctx: new SshExecutionContext(proxy, { root: transport.dir }),
    connectionId: transport.connectionId,
  };
}
