import { type Result, err, ok } from '@switch-console/shared';
import { eq, sql } from 'drizzle-orm';
import {
  agentSidecarTmuxName,
  killSidecarSession,
} from '@main/core/agent-runtime/impl/remote-sidecar-launcher';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { db } from '@main/db/client';
import { agents } from '@main/db/schema';
import { log } from '@main/lib/logger';
import type { Agent, RenameAgentParams } from '@shared/core/agents/agents';
import { agentEvents } from './agent-events';
import { getAgentLocation, getRemoteAgentLocation } from './agent-location';
import { agentNameTaken } from './agent-name-taken';
import { resolveWorkspaceFsFor } from './agent-workspace-fs';
import { connectRemoteAgent } from './connect-remote-agent';
import { getAgentById } from './getAgentById';
import { ensureRemoteWatcher } from './remote-watcher';
import { removeAgentLaunchProfile } from './remove-launch-profile';
import { agentSettingsRelativePath } from './switch-settings-paths';
import { mapAgentRowToAgent } from './utils';

/**
 * Tear down the remote sidecar the agent ran under its previous name, then bring
 * one back up under the new one.
 *
 * A sidecar's tmux name is a hash of `(repo dir, creds slug)` and the slug is the
 * agent's name, so a rename makes the running sidecar unreachable to every code
 * path rather than renaming it: left alone it keeps polling the agent's Switch
 * rooms forever while the next launch starts a second one beside it.
 *
 * Best-effort — a rename must not fail because the VM is unreachable. The
 * leftover is then reaped by `reapStaleSidecarsForAgent` on the next launch.
 */
async function moveSidecarToNewName(previous: Agent, renamed: Agent): Promise<void> {
  try {
    const location = await getRemoteAgentLocation(previous);
    if (!location) return;
    const { host, remoteRepoDir } = await connectRemoteAgent(previous);
    await killSidecarSession(
      host,
      agentSidecarTmuxName(remoteRepoDir, previous.name ?? previous.id),
      log
    );
    await ensureRemoteWatcher(renamed.id);
  } catch (error) {
    log.warn('renameAgent: failed to move the sidecar to the new name', {
      agentId: previous.id,
      error: String(error),
    });
  }
}

/**
 * Move the agent's on-disk state to its new name.
 *
 * Everything Switch Console writes per agent is keyed by the agent's `name` — the
 * Switch credentials at `.switch/agents/<name>.json` and, for a provider with
 * repo-agent definitions, the definition the CLI is launched against
 * (`--agent <name>`). A rename that only updates the row leaves both behind
 * under the old key, and the credentials are unrecoverable: the token is minted
 * once and lives nowhere else, so the agent would silently fall back to the
 * shared `.claude/settings.local.json` identity — possibly another agent's.
 *
 * The new files are written before the old ones are removed, so an interruption
 * leaves a recoverable duplicate rather than nothing.
 *
 * Best-effort — a rename must not fail because the VM is unreachable. A failure
 * here leaves the agent on its old key, which the next launch reports as missing
 * credentials rather than silently mis-authenticating.
 */
async function moveProvisionedFiles(previous: Agent, renamed: Agent): Promise<void> {
  const from = previous.name ?? previous.id;
  const to = renamed.name ?? renamed.id;
  if (from === to) return;

  try {
    const location = await getAgentLocation(previous);
    const ctx = await resolveWorkspaceFsFor(location.sshHost, location.dir);
    try {
      const creds = await ctx.fs.read(agentSettingsRelativePath(from));
      if (creds !== null) await ctx.fs.write(agentSettingsRelativePath(to), creds);

      const behavior = getPlugin(previous.providerId).behavior.repoAgents;
      const definition = behavior ? await behavior.readDefinition(ctx.fs, from) : null;
      if (behavior && definition) {
        await behavior.writeDefinition(ctx.fs, { ...definition, name: to });
      }

      if (creds !== null) await ctx.fs.delete(agentSettingsRelativePath(from));
      if (behavior && definition) await behavior.removeLocal(ctx.fs, from);
    } finally {
      ctx.close();
    }

    // A launch profile (Codex) is keyed on the agent name, so the rename orphans
    // the old-named one; it is rewritten under the new name on the next launch,
    // so just drop the stale file. Reached through its own home filesystem (the
    // repo-dir workspace fs above has no writable home for a remote agent).
    await removeAgentLaunchProfile(previous, location, from);
  } catch (error) {
    log.warn('renameAgent: failed to move the agent files to the new name', {
      agentId: previous.id,
      from,
      to,
      error: String(error),
    });
  }
}

export type RenameAgentError = { type: 'agent-not-found' } | { type: 'name-taken'; name: string };

/**
 * Rename an agent and move the on-disk state keyed by its old name.
 *
 * The name must be free in the agent's location before anything is written:
 * {@link moveProvisionedFiles} writes the credentials to the destination
 * unconditionally, so renaming onto a sibling would hand that sibling this
 * agent's Switch token and then delete the original.
 */
export async function renameAgent(
  params: RenameAgentParams
): Promise<Result<Agent, RenameAgentError>> {
  const previous = await getAgentById(params.agentId);
  if (!previous) return err({ type: 'agent-not-found' });

  if (await agentNameTaken(previous.locationId, params.newName, previous.id)) {
    return err({ type: 'name-taken', name: params.newName });
  }

  const [row] = await db
    .update(agents)
    .set({ name: params.newName, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(agents.id, params.agentId))
    .returning();
  if (!row) return err({ type: 'agent-not-found' });

  const renamed = mapAgentRowToAgent(row);
  if (previous.name !== renamed.name) {
    await moveProvisionedFiles(previous, renamed);
    await moveSidecarToNewName(previous, renamed);
  }
  agentEvents._emit('agent:updated', renamed);
  return ok(renamed);
}
