import { resolveAgentExecutable } from '@main/core/agent-runtime/impl/resolve-agent-executable';
import { resolveSwitchLaunchProfile } from '@main/core/agent-runtime/switch-mcp-launch-args';
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
 * `autoApprove` is the agent's per-agent bypass-permissions setting, baked into
 * the spec's argv so the VM watcher's auto-started sessions honor it (CHOO-1664)
 * — mirroring the local auto-session watcher, which reads the same setting.
 */
export async function generateAgentLaunchSpec(params: {
  providerId: string;
  /** Absolute remote working dir the agent runs in. */
  remoteRepoDir: string;
  deeplinkScheme: string;
  /** The agent's bypass-permissions setting, applied to auto-started sessions. */
  autoApprove: boolean;
  /** The agent's definition name, so auto-started sessions launch as the
   * definition (`--agent <name> --settings <neutral creds>`) with its own model,
   * prompt, tools, and Switch identity. Null for a provider/agent with no
   * on-disk definition (CHOO-1440). */
  agentName: string | null;
  /** Per-agent creds slug (the agent's name) — keys the Switch launch profile a
   * provider that registers the server itself writes (Codex). */
  credsSlug: string;
  ctx: IExecutionContext;
  connectionId: string;
}): Promise<AgentLaunchSpec> {
  const {
    providerId,
    remoteRepoDir,
    deeplinkScheme,
    autoApprove,
    agentName,
    credsSlug,
    ctx,
    connectionId,
  } = params;
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

  // Auto-started sessions always run as the agent, so they have a Switch
  // identity. A provider that registers the server itself (Codex) returns the
  // profile file to bake into the spec and the `--profile <slug>` argv; the
  // sidecar writes the file on the VM. Null for providers whose plugin resolves
  // the server from a bundled config (Claude).
  const switchProfile = resolveSwitchLaunchProfile(plugin, {
    slug: credsSlug,
    hasSwitchIdentity: true,
  });

  const repoAgents = plugin.behavior.repoAgents;
  const agentCommand = plugin.behavior.prompt.buildCommand({
    cli,
    extraArgs: parseExtraArgs(providerConfig?.extraArgs),
    // The provider owns how to run as the named agent (CHOO-1440); kept distinct
    // from user extra args.
    agentArgs: [
      ...(agentName && repoAgents ? repoAgents.launchArgs(remoteRepoDir, agentName) : []),
      ...(switchProfile?.args ?? []),
    ],
    autoApprove,
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
    launchFiles: switchProfile
      ? [{ homeRelativePath: switchProfile.relativePath, content: switchProfile.content }]
      : undefined,
    providerId,
    deeplinkScheme,
  };
}
