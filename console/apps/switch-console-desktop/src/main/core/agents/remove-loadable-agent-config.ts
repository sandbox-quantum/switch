import { log } from '@main/lib/logger';
import { resolveWorkspaceFsFor } from './agent-workspace-fs';
import { agentSettingsRelativePath } from './switch-settings-paths';

export type RemoveLoadableAgentConfigParams = {
  sshHost: string | null;
  dir: string;
  name: string;
};

export type RemoveLoadableAgentConfigResult =
  | { removed: true }
  | { removed: false; reason: 'not-found' };

/**
 * Delete an agent's on-disk config (`.switch/agents/<name>.json`) from a
 * working directory, so a stale or wrong-endpoint entry surfaced by "Load
 * existing agents" can be cleaned up in place (CHOO-2560).
 *
 * Deliberately host-file-only: the agent's registration on the Switch server
 * is untouched (deregistering is the owner's call, made from an attached
 * agent's own page), and no Console rows anywhere are affected. Callers
 * should not offer this for agents already loaded in this Console — deleting
 * the file under a managed agent breaks its launches.
 */
export async function removeLoadableAgentConfig(
  params: RemoveLoadableAgentConfigParams
): Promise<RemoveLoadableAgentConfigResult> {
  const relPath = agentSettingsRelativePath(params.name);
  const ctx = await resolveWorkspaceFsFor(params.sshHost, params.dir);
  try {
    const existing = await ctx.fs.read(relPath);
    if (existing === null) return { removed: false, reason: 'not-found' };
    await ctx.fs.delete(relPath);
    log.info('removeLoadableAgentConfig: deleted agent config', {
      sshHost: params.sshHost,
      dir: params.dir,
      name: params.name,
    });
    return { removed: true };
  } finally {
    ctx.close();
  }
}
