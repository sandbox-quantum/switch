import { resolveAgentExecutable } from '@main/core/agent-runtime/impl/resolve-agent-executable';
import { hostDependencyStore } from '@main/core/dependencies/host-dependency-store';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { providerOverrideSettings } from '@main/core/settings/provider-settings-service';
import {
  type AgentLaunchSpec,
  INITIAL_PROMPT_PLACEHOLDER,
  SESSION_ID_PLACEHOLDER,
} from '../../../sidecar/agent-launch-spec';

function parseExtraArgs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.trim().split(/\s+/);
}

/**
 * Precompute the provider-specific launch recipe for a remote agent's
 * auto-started sessions, resolving the agent binary on the VM and baking in
 * placeholder tokens for the two per-spawn values (session id + initial
 * prompt). The VM watcher — which has no plugin registry — substitutes those
 * tokens per spawn, so all provider knowledge stays here in switchdash.
 *
 * Auto-started sessions always run with autoApprove: a headless VM session has
 * no operator to answer permission prompts, matching the local auto-session
 * watcher's `autoApprove: true`.
 */
export async function generateAgentLaunchSpec(params: {
  providerId: string;
  /** Absolute remote working dir the agent runs in. */
  remoteRepoDir: string;
  deeplinkScheme: string;
  ctx: IExecutionContext;
  connectionId: string;
}): Promise<AgentLaunchSpec> {
  const { providerId, remoteRepoDir, deeplinkScheme, ctx, connectionId } = params;
  const plugin = getPlugin(providerId);
  if (!plugin.behavior.prompt) {
    throw new Error(
      `provider ${providerId} has no prompt.buildCommand; cannot auto-start sessions`
    );
  }

  const providerConfig = await providerOverrideSettings.getItem(providerId);
  const binaryName = plugin.capabilities.hostDependency.binaryNames[0] ?? providerId;
  const cli = await resolveAgentExecutable({
    providerId,
    binaryName,
    ctx,
    hostDependencyStore,
    connectionId,
  });

  const agentCommand = plugin.behavior.prompt.buildCommand({
    cli,
    extraArgs: parseExtraArgs(providerConfig?.extraArgs),
    autoApprove: true,
    initialPrompt: INITIAL_PROMPT_PLACEHOLDER,
    sessionId: SESSION_ID_PLACEHOLDER,
    providerSessionId: undefined,
    isResuming: false,
    model: '',
  });

  return {
    command: agentCommand.command,
    args: agentCommand.args,
    env: { ...agentCommand.env, ...(providerConfig?.env ?? {}) },
    cwd: remoteRepoDir,
    providerId,
    deeplinkScheme,
  };
}
