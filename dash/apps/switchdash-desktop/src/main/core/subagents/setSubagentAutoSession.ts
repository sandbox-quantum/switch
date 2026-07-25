import { getAgentById } from '@main/core/agents/getAgentById';
import { getAgents } from '@main/core/agents/getAgents';
import {
  listAutoSessionSubagents,
  setAutoSessionSubagent,
} from '@main/core/switch-rooms/auto-session-store';
import { autoSessionWatcher } from '@main/core/switch-rooms/auto-session-watcher';
import {
  fetchAgentOptions,
  GatewayError,
  setAutoSession,
} from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';

export type SubagentAutoSessionParams = {
  parentAgentId: string;
  name: string;
  enabled: boolean;
};

/**
 * Apply a subagent's auto_session state to the LOCAL side only: mirror the flag
 * and start/stop its watcher. Does NOT touch the gateway profile — callers that
 * also mutate the gateway must do so separately.
 */
export async function applyLocalSubagentAutoSessionState(
  parentAgentId: string,
  name: string,
  enabled: boolean
): Promise<void> {
  await setAutoSessionSubagent(parentAgentId, name, enabled);
  await autoSessionWatcher.reconcileSubagent(parentAgentId, name, enabled);
}

/** Resolve a subagent's own Switch agent id (needed to flip its gateway profile).
 * A subagent is an agent row carrying `definitionName` in the parent's location. */
async function resolveSubagentSwitchId(
  parentAgentId: string,
  name: string
): Promise<string | null> {
  const parent = await getAgentById(parentAgentId);
  if (!parent) return null;
  const row = (await getAgents(parent.locationId)).find((a) => a.definitionName === name);
  return row?.switchAgentId ?? null;
}

/**
 * Toggle a subagent's auto_session capability. Same single write path as
 * {@link setAgentAutoSession}, but keyed by the subagent's own Switch agent id:
 * flips its gateway profile (`connection_model` ⇄ `auto_session`), mirrors the
 * flag locally, and starts/stops a watcher that spawns sessions launched as that
 * subagent. The parent agent must be linked to a Switch server.
 */
export async function setSubagentAutoSession(params: SubagentAutoSessionParams): Promise<void> {
  const parent = await getAgentById(params.parentAgentId);
  if (!parent) throw new Error(`No agent with id ${params.parentAgentId}`);
  if (!parent.serverId || !parent.switchAgentId) {
    throw new Error('Parent agent is not linked to a Switch server; cannot set auto_session.');
  }
  const server = await getServer(parent.serverId);
  if (!server) throw new Error(`No Switch server with id ${parent.serverId}`);

  const switchAgentId = await resolveSubagentSwitchId(params.parentAgentId, params.name);
  if (!switchAgentId) {
    throw new Error(`Subagent ${params.name} has no Switch agent id; cannot set auto_session.`);
  }

  await setAutoSession(server, switchAgentId, params.enabled);
  await applyLocalSubagentAutoSessionState(params.parentAgentId, params.name, params.enabled);
}

/**
 * Read whether a subagent has auto_session enabled, reconciling the local mirror
 * (and the watcher) from the subagent's gateway profile. Falls back to the local
 * mirror if the gateway is unreachable, so the UI can still render a value.
 */
export async function getSubagentAutoSession(params: {
  parentAgentId: string;
  name: string;
}): Promise<boolean> {
  const parent = await getAgentById(params.parentAgentId);
  if (!parent?.serverId || !parent.switchAgentId) return false;
  const server = await getServer(parent.serverId);
  if (!server) return false;

  const switchAgentId = await resolveSubagentSwitchId(params.parentAgentId, params.name);
  if (!switchAgentId) return false;

  try {
    const { connectionModel } = await fetchAgentOptions(server, switchAgentId);
    const enabled = connectionModel === 'auto_session';
    await applyLocalSubagentAutoSessionState(params.parentAgentId, params.name, enabled);
    return enabled;
  } catch (error) {
    if (error instanceof GatewayError) {
      log.warn('getSubagentAutoSession: could not read gateway profile; using local mirror', {
        parentAgentId: params.parentAgentId,
        name: params.name,
        error: error.message,
      });
      return (await listAutoSessionSubagents()).some(
        (s) => s.parentAgentId === params.parentAgentId && s.name === params.name
      );
    }
    throw error;
  }
}
