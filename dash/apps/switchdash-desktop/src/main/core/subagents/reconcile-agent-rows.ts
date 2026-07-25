import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { createAgent } from '@main/core/agents/createAgent';
import { getAgents } from '@main/core/agents/getAgents';
import {
  agentSettingsRelativePath,
  SWITCH_AGENTS_GITIGNORE_RELATIVE,
  SWITCH_SUBAGENTS_DIR_RELATIVE,
} from '@main/core/agents/switch-settings-paths';
import { writeAgentNeutralSettings } from '@main/core/agents/write-switch-settings';
import { getLocationById, getLocations } from '@main/core/locations/store';
import { createPluginFs } from '@main/core/providers/plugin-fs';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { readSwitchAgentCredentials } from '@main/core/switch-rooms/switch-credentials';
import { log } from '@main/lib/logger';

/**
 * Move a location's legacy per-subagent credentials from the Claude-specific
 * `.claude/switch-subagents/<name>.settings.json` layout to the provider-neutral
 * `.switch/agents/<name>.json` layout (CHOO-1440). Idempotent: files already at
 * the neutral location are left untouched. Best-effort; the credential readers
 * fall back to the legacy location, so a partial move never breaks launch.
 */
async function migrateLegacyCredsToNeutral(dir: string): Promise<void> {
  const fs = createPluginFs(dir);
  const legacy = (await fs.list(SWITCH_SUBAGENTS_DIR_RELATIVE)).filter((e) =>
    e.endsWith('.settings.json')
  );
  if (legacy.length === 0) return;
  if (!(await fs.exists(SWITCH_AGENTS_GITIGNORE_RELATIVE))) {
    await fs.write(SWITCH_AGENTS_GITIGNORE_RELATIVE, '*\n');
  }
  for (const entry of legacy) {
    const name = entry.slice(0, -'.settings.json'.length);
    const neutralRel = agentSettingsRelativePath(name);
    if (await fs.exists(neutralRel)) continue;
    const content = await fs.read(path.join(SWITCH_SUBAGENTS_DIR_RELATIVE, entry));
    if (content === null) continue;
    await fs.write(neutralRel, content);
    await fs.delete(path.join(SWITCH_SUBAGENTS_DIR_RELATIVE, entry));
  }
}

/**
 * Sync a location's on-disk subagent definitions into first-class agent rows.
 *
 * In the collapsed model a subagent is just an agent that launches as a provider
 * definition (its `definitionName`), sharing a location with the other agents.
 * So the only subagent-specific bookkeeping left is keeping the `agents` table in
 * step with the provider's on-disk, credentialed definitions. This is that step,
 * and it doubles as the backfill for existing installs (CHOO-1440).
 *
 * For each real agent in the location (one with no `definitionName`) whose
 * provider supports subagents and that is linked to a server, discover the
 * launchable subagents in the location dir and create an agent row for any not
 * already represented — matched by `definitionName`, or by `switchAgentId` when
 * present. The new row inherits the parent's provider and server (subagents are
 * registered as children on the same server) and its own Switch identity from the
 * discovered credentials. Idempotent; best-effort per parent.
 *
 * Local locations only: a remote location's working dir lives on its SSH host, so
 * its subagents are materialised through the remote onboarding path, not here.
 */
export async function reconcileAgentRowsForLocation(
  locationId: string
): Promise<{ created: number }> {
  const location = await getLocationById(locationId);
  if (!location || location.sshHost) return { created: 0 };

  await migrateLegacyCredsToNeutral(location.dir).catch((error) => {
    log.warn('reconcileAgentRows: legacy creds migration failed', {
      locationId,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  const agentsInLocation = await getAgents(locationId);

  // Backfill the primary main agent's provider-neutral per-agent creds file from
  // `.claude/settings.local.json` (the agent that currently owns that identity),
  // so launch/poller can inject it. Best-effort (CHOO-1440).
  const settingsCreds = await readSwitchAgentCredentials(location.dir, log);
  if (settingsCreds) {
    const owner = agentsInLocation.find(
      (a) => a.definitionName === null && a.switchAgentId === settingsCreds.agentId
    );
    if (owner) {
      await writeAgentNeutralSettings({
        dir: location.dir,
        slug: owner.id,
        apiEndpoint: settingsCreds.apiEndpoint,
        apiToken: settingsCreds.token,
        agentId: settingsCreds.agentId,
      }).catch((error) => {
        log.warn('reconcileAgentRows: failed to sync neutral creds for main agent', {
          agentId: owner.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  const seenDefinitionNames = new Set(
    agentsInLocation.map((a) => a.definitionName).filter((name): name is string => name !== null)
  );
  const seenSwitchIds = new Set(
    agentsInLocation.map((a) => a.switchAgentId).filter((id): id is string => id !== null)
  );

  const parents = agentsInLocation.filter(
    (a) =>
      a.definitionName === null &&
      a.serverId !== null &&
      !!getPlugin(a.providerId).behavior.subagents
  );

  const fs = createPluginFs(location.dir);
  const homeFs = createPluginFs(homedir());
  let created = 0;

  for (const parent of parents) {
    const behavior = getPlugin(parent.providerId).behavior.subagents;
    if (!behavior || parent.serverId === null) continue;
    let discovered;
    try {
      discovered = await behavior.discoverLocal(fs, homeFs);
    } catch (error) {
      log.warn('reconcileAgentRows: local discovery failed', {
        locationId,
        parentAgentId: parent.id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    for (const sub of discovered) {
      if (seenDefinitionNames.has(sub.name)) continue;
      if (sub.switchAgentId !== null && seenSwitchIds.has(sub.switchAgentId)) continue;

      await createAgent({
        id: randomUUID(),
        locationId,
        name: sub.name,
        providerId: parent.providerId,
        definitionName: sub.name,
        switchAgentId: sub.switchAgentId,
        apiEndpoint: sub.apiEndpoint,
        serverId: parent.serverId,
        autoApprove: false,
      });
      seenDefinitionNames.add(sub.name);
      if (sub.switchAgentId !== null) seenSwitchIds.add(sub.switchAgentId);
      created++;
    }
  }

  return { created };
}

/**
 * Reconcile every local location's subagent definitions into agent rows. Run at
 * boot so existing installs' on-disk subagents become first-class agents (the
 * backfill for the subagent collapse). Best-effort per location.
 */
export async function reconcileAllAgentRows(): Promise<void> {
  const locations = await getLocations();
  for (const location of locations) {
    if (location.sshHost) continue;
    try {
      await reconcileAgentRowsForLocation(location.id);
    } catch (error) {
      log.warn('reconcileAgentRows: failed for location', {
        locationId: location.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
