import type { PluginFs } from '@switch-console/core/agents/plugins';
import { eq, sql } from 'drizzle-orm';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { parseSwitchAgentCredentials } from '@main/core/switch-rooms/switch-credentials';
import { db } from '@main/db/client';
import { agents } from '@main/db/schema';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import { agentEvents } from './agent-events';
import { getAgentLocation } from './agent-location';
import { agentNameTaken } from './agent-name-taken';
import { resolveWorkdirFsFor } from './agent-workdir-fs';
import { getAgentById } from './getAgentById';
import { ensureRemoteWatcher } from './remote-watcher';
import { removeAgentLaunchProfile } from './remove-launch-profile';
import { agentConfigRelativePath, agentSettingsRelativePath } from './switch-settings-paths';
import { mapAgentRow } from './utils';
import { foreignCredentialsEndpoint } from './write-switch-settings';

export type RenameLocalAgentError =
  | { type: 'agent-not-found' }
  | { type: 'name-taken'; name: string }
  /** The new name's credentials file in the agent's directory belongs to
   * another Switch server: a second Console install's agent, which this
   * install's database cannot see. Nothing was renamed. */
  | { type: 'credentials-conflict'; name: string; endpoint: string };

export class RenameLocalAgentFailed extends Error {
  constructor(readonly reason: RenameLocalAgentError) {
    super(
      reason.type === 'agent-not-found'
        ? 'This agent no longer exists in Switch Console.'
        : reason.type === 'name-taken'
          ? `Another agent here is already called ${reason.name}.`
          : `The name ${reason.name} is already used in this folder by the Switch server at ${reason.endpoint}.`
    );
  }
}

/**
 * The Switch server that owns the credentials already sitting at `to`, when it
 * is not the one `credsRaw` (this agent's own credentials) names; otherwise
 * null. A file with no readable credentials is not an owner.
 */
async function foreignOwnerAt(fs: PluginFs, credsRaw: string, to: string): Promise<string | null> {
  const source = parseSwitchAgentCredentials(credsRaw, log);
  if (!source) return null;
  return foreignCredentialsEndpoint(
    await fs.read(agentSettingsRelativePath(to)),
    source.apiEndpoint
  );
}

async function foreignCredentialsAtNewName(agent: Agent, to: string): Promise<string | null> {
  const from = agent.name ?? agent.id;
  if (from === to) return null;
  try {
    const location = await getAgentLocation(agent);
    const ctx = await resolveWorkdirFsFor(location.sshHost, location.dir);
    try {
      const creds = await ctx.fs.read(agentSettingsRelativePath(from));
      return creds === null ? null : await foreignOwnerAt(ctx.fs, creds, to);
    } finally {
      ctx.close();
    }
  } catch (error) {
    log.warn('renameAgent: could not check the new name for another Console install', {
      agentId: agent.id,
      to,
      error: String(error),
    });
    return null;
  }
}

/**
 * Move what Console keeps per agent, keyed by its name, to the new name: its
 * Switch credentials (`.switch/agents/<name>.json`), its config
 * (`.switch/config/<name>.json`), and a provider's agent definition. Without
 * this the renamed agent would launch without its token, which lives nowhere
 * else.
 *
 * New files are written before old ones are removed, so an interruption
 * leaves a duplicate rather than nothing. Best-effort, as a delete's teardown
 * is: a failure is logged and leaves the agent on its old files, which the
 * next launch reports as missing credentials rather than guessing.
 */
async function moveProvisionedFiles(previous: Agent, renamed: Agent): Promise<void> {
  const from = previous.name ?? previous.id;
  const to = renamed.name ?? renamed.id;
  if (from === to) return;
  try {
    const location = await getAgentLocation(previous);
    const ctx = await resolveWorkdirFsFor(location.sshHost, location.dir);
    try {
      const creds = await ctx.fs.read(agentSettingsRelativePath(from));
      if (creds !== null) {
        // Checked again at the write that would do the damage: it overwrites,
        // so another install's token would be gone without a trace.
        const owner = await foreignOwnerAt(ctx.fs, creds, to);
        if (owner !== null) {
          throw new Error(
            `${agentSettingsRelativePath(to)} belongs to the Switch server at ${owner}; refusing to overwrite another install's credentials`
          );
        }
        await ctx.fs.write(agentSettingsRelativePath(to), creds);
      }
      const config = await ctx.fs.read(agentConfigRelativePath(from));
      if (config !== null) await ctx.fs.write(agentConfigRelativePath(to), config);

      const behavior = getPlugin(previous.providerId).behavior.repoAgents;
      const definition = behavior ? await behavior.readDefinition(ctx.fs, from) : null;
      if (behavior && definition)
        await behavior.writeDefinition(ctx.fs, { ...definition, name: to });

      if (creds !== null) await ctx.fs.delete(agentSettingsRelativePath(from));
      if (config !== null) await ctx.fs.delete(agentConfigRelativePath(from));
      if (behavior && definition) await behavior.removeLocal(ctx.fs, from);
    } finally {
      ctx.close();
    }
    // A launch profile is keyed on the name and rewritten under the new one on
    // the next launch, so the old one is only dropped.
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

/**
 * Give a Console agent its new name locally, once its Switch server has
 * renamed it: the row, then the files keyed by the old name, then its watcher.
 * Sessions read the agent's name live from the row, so they follow.
 *
 * Refuses before writing anything when the name is taken here, or when the
 * new name's credentials slot is another server's.
 */
export async function renameLocalAgent(params: {
  agentId: string;
  newName: string;
}): Promise<Agent> {
  const previous = await getAgentById(params.agentId);
  if (!previous) throw new RenameLocalAgentFailed({ type: 'agent-not-found' });
  if (previous.name === params.newName) return previous;

  if (await agentNameTaken(previous.locationId, params.newName, previous.id)) {
    throw new RenameLocalAgentFailed({ type: 'name-taken', name: params.newName });
  }
  const foreign = await foreignCredentialsAtNewName(previous, params.newName);
  if (foreign !== null) {
    throw new RenameLocalAgentFailed({
      type: 'credentials-conflict',
      name: params.newName,
      endpoint: foreign,
    });
  }

  const [row] = await db
    .update(agents)
    .set({ name: params.newName, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(agents.id, params.agentId))
    .returning();
  if (!row) throw new RenameLocalAgentFailed({ type: 'agent-not-found' });

  const renamed = await mapAgentRow(row);
  await moveProvisionedFiles(previous, renamed);
  await ensureRemoteWatcher(renamed.id);
  agentEvents._emit('agent:updated', renamed);
  return renamed;
}
