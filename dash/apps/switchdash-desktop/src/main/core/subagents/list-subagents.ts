import type { LocalSubagent } from '@switchdash/core/agents/plugins';
import { getAgentById } from '@main/core/agents/getAgentById';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { fetchAgentChildren, GatewayError } from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';
import type { SubagentListResult } from '@shared/core/subagents/subagents';
import { reconcileSubagents } from './reconcile';
import { resolveSubagentFs } from './resolve-subagent-fs';

/**
 * List a parent agent's Claude Code subagents: discover them from the parent's
 * `.claude/switch-subagents/` credentials — on local disk or, for a remote
 * agent, on its SSH host over SFTP — then reconcile against the gateway's
 * registered children. Both discovery and reconciliation are best-effort: if the
 * parent has no directory, its host is unreachable, or the gateway is
 * unreachable, the listing degrades rather than failing (empty local set and/or
 * `registered: null`).
 */
export async function listSubagents(parentAgentId: string): Promise<SubagentListResult> {
  const parent = await getAgentById(parentAgentId);
  if (!parent) {
    return { parentAgentId, subagents: [], remoteOnly: [], reconciled: false };
  }

  const subagentsBehavior = getPlugin(parent.providerId).behavior.subagents;
  let local: LocalSubagent[] = [];
  if (subagentsBehavior) {
    try {
      const ctx = await resolveSubagentFs(parentAgentId);
      try {
        local = await subagentsBehavior.discoverLocal(ctx.fs, ctx.homeFs);
      } finally {
        ctx.close();
      }
    } catch (error) {
      // Discovery is best-effort: an unreachable host or a parent without a
      // directory degrades to gateway-only reconciliation, it does not fail.
      log.warn('subagents: local discovery failed', {
        parentAgentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let remote: Awaited<ReturnType<typeof fetchAgentChildren>> | null = null;
  if (parent.serverId && parent.switchAgentId) {
    const server = await getServer(parent.serverId);
    if (server) {
      try {
        remote = await fetchAgentChildren(server, parent.switchAgentId);
      } catch (error) {
        // Reconciliation is best-effort: a sign-in or connectivity problem
        // degrades to local-only, it does not fail the listing.
        log.warn('subagents: gateway reconciliation failed', {
          parentAgentId,
          error: error instanceof GatewayError ? error.message : String(error),
        });
      }
    }
  }

  const { subagents, remoteOnly } = reconcileSubagents({
    parentAgentId,
    serverId: parent.serverId,
    local,
    remote,
  });

  return { parentAgentId, subagents, remoteOnly, reconciled: remote !== null };
}
