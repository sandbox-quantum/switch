import type { SubagentAttributes } from '@switchdash/core/agents/plugins';
import { getRemoteAgentLocation } from '@main/core/agents/agent-location';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { getServer } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';
import { registerSubagentsCore } from './register-subagents';
import { resolveSubagentFs } from './resolve-subagent-fs';
import { applyLocalSubagentAutoSessionState } from './setSubagentAutoSession';

export type CreateSubagentParams = {
  /** The parent agent to create the subagent under. Its provider, Switch server,
   * identity, and working directory (local or remote) are resolved from it. */
  parentAgentId: string;
  /** The subagent's attributes, keyed by the provider's attribute fields. Must
   * include `name` and `description`. */
  attributes: SubagentAttributes;
};

function requireString(attributes: SubagentAttributes, key: string): string {
  const value = attributes[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Author a new subagent from switchdash: write its definition from the given
 * attributes, then register it on the gateway and write its credentials so it is
 * immediately launchable. Works for both local and remote parents — the parent's
 * working directory (local disk or its SSH host over SFTP) is resolved from the
 * agent. If gateway registration fails the just-written definition is removed so
 * a half-created subagent isn't left behind.
 */
export async function createSubagent(params: CreateSubagentParams): Promise<{ name: string }> {
  const name = requireString(params.attributes, 'name');
  const description = requireString(params.attributes, 'description');
  if (!name) throw new Error('A subagent name is required.');
  if (!description) throw new Error('A subagent description is required.');

  const ctx = await resolveSubagentFs(params.parentAgentId);
  try {
    const { agent } = ctx;
    const behavior = getPlugin(agent.providerId).behavior.subagents;
    if (!behavior) {
      throw new Error(`Provider ${agent.providerId} does not support subagents.`);
    }
    if (!agent.serverId) {
      throw new Error(`Agent ${params.parentAgentId} is not linked to a Switch server.`);
    }
    if (!agent.switchAgentId) {
      throw new Error(`Agent ${params.parentAgentId} has no Switch identity.`);
    }

    if (await behavior.readDefinition(ctx.fs, name)) {
      throw new Error(`A subagent named "${name}" already exists.`);
    }

    await behavior.writeDefinition(ctx.fs, params.attributes);

    // Subagents of remote parents register with auto_session off: neither the
    // local watcher (no local dir) nor the on-VM sidecar watches subagents.
    const autoSession = (await getRemoteAgentLocation(agent)) === null;
    try {
      const server = await getServer(agent.serverId);
      if (!server) throw new Error(`No Switch server with id ${agent.serverId}`);
      await registerSubagentsCore({
        behavior,
        server,
        parentSwitchAgentId: agent.switchAgentId,
        fs: ctx.fs,
        subagents: [{ name, description }],
        autoSession,
      });
    } catch (error) {
      await behavior.removeLocal(ctx.fs, name);
      throw error;
    }

    // Seed the local auto_session mirror + start the watcher so the new
    // subagent begins watching now, without an off→on toggle. Best-effort: a
    // failure must not fail creation (the settings panel reconciles later).
    if (autoSession) {
      await applyLocalSubagentAutoSessionState(params.parentAgentId, name, true).catch((error) => {
        log.warn('createSubagent: failed to start auto_session watcher for new subagent', {
          parentAgentId: params.parentAgentId,
          name,
          error: String(error),
        });
      });
    }

    return { name };
  } finally {
    ctx.close();
  }
}
