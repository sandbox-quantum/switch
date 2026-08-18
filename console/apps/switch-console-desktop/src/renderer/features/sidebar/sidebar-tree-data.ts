import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import type { LocationStore } from '@renderer/features/locations/stores/location';
import type { SessionStore } from '@renderer/features/sessions/stores/session-store';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { log } from '@renderer/utils/logger';
import type { Agent } from '@shared/core/agents/agents';
import type { AgentIconBackfill } from '@shared/core/switch-servers/switch-servers';

/**
 * What the two sidebar trees agree on: which agents are in scope and which
 * sessions belong to them. Everything past that — how they are nested, what a
 * row does — is the trees' own business and deliberately not shared.
 */

/** An agent paired with its (mounted) location, for the flat sidebar list. */
export type AgentEntry = { agent: Agent; location: LocationStore };

/**
 * A location's agents that the active server's tree should draw.
 *
 * A location is in scope when *some* of its agents are on the active server, but a
 * directory can hold agents for several servers at once — so scope has to be
 * re-applied per agent here. Taking the location's whole list instead drew agents
 * belonging to another server under this one, which read as "onboarding brought
 * them across" when nothing had been onboarded at all (CHOO-2044).
 */
function agentsAtLocationInScope(location: LocationStore): Agent[] {
  const activeServerId = switchServersStore.activeServerId;
  if (!activeServerId) return agentsStore.byLocation.get(location.id) ?? [];
  return agentsStore.agentsOnServerAtLocation(location.id, activeServerId);
}

/**
 * The flat list of agents in the active-server scope. Switch Console shows agents
 * as a flat list — not grouped by directory (CHOO-1440).
 *
 * Newest first, then overlaid with the user's manual drag order: an agent they
 * have positioned stays where they put it, and one they have not sorts after
 * those by recency.
 */
export function scopedAgents(): AgentEntry[] {
  const entries: AgentEntry[] = [];
  for (const location of sidebarStore.filteredLocations) {
    for (const agent of agentsAtLocationInScope(location)) {
      entries.push({ agent, location });
    }
  }
  entries.sort(
    (a, b) =>
      b.agent.createdAt.localeCompare(a.agent.createdAt) || a.agent.name.localeCompare(b.agent.name)
  );
  return sidebarStore.orderAgents(entries, (entry) => entry.agent.id);
}

/**
 * Every agent on the active server, ignoring the agent filters.
 *
 * Room membership is a fact about a room, so the agents a room lists — and the
 * agents whose membership is fetched at all — must not depend on which filters
 * the agent view happens to have set. {@link scopedAgents} is the filtered list
 * and stays the right one for rendering the agent tree itself.
 */
export function agentsInActiveScope(): AgentEntry[] {
  const entries: AgentEntry[] = [];
  for (const location of sidebarStore.orderedLocations) {
    for (const agent of agentsAtLocationInScope(location)) {
      entries.push({ agent, location });
    }
  }
  return entries;
}

/**
 * An agent's visible sessions: the location's sessions it owns. Sessions are
 * paired to their agent by `agent_id` — the authoritative link — not by matching
 * a name frozen into the session's config against the agent's definition. A
 * session whose owning agent no longer matches by name is still shown under its
 * agent instead of silently vanishing (CHOO-1440).
 */
export function agentSessions(entry: AgentEntry): SessionStore[] {
  const all = sidebarStore.visibleSessionsForLocation(entry.location.id);
  return all.filter(
    (session) => 'agentId' in session.data && session.data.agentId === entry.agent.id
  );
}

/** Every agent on the active server that has a Switch identity, as
 * membership-lookup keys. Unfiltered on purpose — see
 * {@link agentsInActiveScope}. */
export function switchIdentities(): { serverId: string; switchAgentId: string }[] {
  const identities: { serverId: string; switchAgentId: string }[] = [];
  for (const { agent } of agentsInActiveScope()) {
    if (agent.serverId && agent.switchAgentId) {
      identities.push({ serverId: agent.serverId, switchAgentId: agent.switchAgentId });
    }
  }
  return identities;
}

/**
 * Re-read everything the sidebar's trees are built from: this install's agents,
 * their room membership, and the room catalogue.
 *
 * One function for every "catch up with the world" trigger — first paint, window
 * focus, signing in to a server, the background reconcile, the retry button, and
 * any mutation here that changes membership. The bug this exists to prevent is
 * triggers refreshing different subsets of the same state.
 *
 * It re-reads the agent list *first* and derives the identities from that, which
 * is what makes it correct after a room is created with an agent onboarded
 * moments earlier: refreshing membership for the previously-known identities
 * would skip the new agent, and it would surface only at the next reconcile.
 */
export async function refreshSidebarRoomState(force: boolean): Promise<void> {
  await agentsStore.load();
  await Promise.all([
    switchRoomsStore.ensureMembershipsFor(switchIdentities(), { force }),
    switchRoomsStore.loadRoomNames(),
  ]);
  void giveExistingAgentsAnIcon();
}

/**
 * Gaps between the passes {@link refreshSidebarRoomStateAfterOnboarding} makes.
 * Spread over a few seconds rather than fired once, because the state being
 * waited for does not exist yet when onboarding returns.
 */
const POST_ONBOARD_REFRESH_GAPS_MS = [0, 2_000, 4_000];

/**
 * Catch up after onboarding an agent, whose rooms land asynchronously.
 *
 * Onboarding returns once the agent is registered, but its room membership is
 * still being written: the collaboration bridge creates the agent's bot on the
 * chat platform and adds it to the team, the platform auto-joins it to that
 * team's default channels, and only then does the bridge see those joins and
 * record the rooms. A single refresh on completion reliably loses that race and
 * leaves the new agent looking roomless until the background reconcile, so
 * re-read a few times across the window in which the server settles.
 */
export async function refreshSidebarRoomStateAfterOnboarding(): Promise<void> {
  for (const gap of POST_ONBOARD_REFRESH_GAPS_MS) {
    if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
    await refreshSidebarRoomState(true);
  }
}

/**
 * Fill in the avatar of any of this user's agents registered before icons
 * existed (CHOO-2171). The main process does it once per server per run, so
 * calling it on every refresh costs nothing after the first.
 *
 * Not awaited by the caller and never allowed to throw: the sidebar must paint
 * whether or not the gateway is reachable, and an agent without an icon still
 * shows the avatar its name generates in the meantime.
 *
 * **A failure here has to be said out loud.** That name-derived avatar makes
 * the app look finished whether or not the server accepted anything, and the
 * only place the difference shows is Slack — where the agent keeps its old
 * lettered picture with nothing explaining why.
 */
async function giveExistingAgentsAnIcon(): Promise<void> {
  const serverIds = new Set(switchIdentities().map((identity) => identity.serverId));
  for (const serverId of serverIds) {
    try {
      reportBackfill(await rpc.switchServers.backfillAgentIcons(serverId));
    } catch (cause) {
      log.warn('could not give existing agents their icons', { serverId, cause });
      toast({
        title: 'Agent icons could not be saved',
        description:
          'Your agents show a generated icon here, but the Switch server has not stored it — so they keep their old picture in Slack and the other chat apps.',
        variant: 'destructive',
      });
    }
  }
}

function reportBackfill(outcome: AgentIconBackfill): void {
  if (outcome.kind === 'unsupported') {
    toast({
      title: 'This Switch server does not support agent icons yet',
      description:
        'Your agents show a generated icon here, but it cannot be saved, so they keep their old picture in Slack and the other chat apps. Updating the server fixes it.',
      variant: 'destructive',
    });
    return;
  }
  if (outcome.kind === 'partial') {
    toast({
      title: `${outcome.failed} agent${outcome.failed === 1 ? '' : 's'} kept the old icon`,
      description:
        'Their icon could not be saved to the Switch server, so it will not show in Slack or the other chat apps.',
      variant: 'destructive',
    });
  }
}
