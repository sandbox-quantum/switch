import { managedAgentLabel } from '@renderer/features/managed-agents/managed-agent-state';
import { isConsoleDirectChatSummary } from '@renderer/features/switch-servers/room-filters';
import { type ChatSummary, chatAgentLabel } from '@shared/core/chats/chats';
import type { ManagedAgentView } from '@shared/core/managed-agents/managed-agents';
import { matchQuality, type SearchItem, type SearchItemKind } from '@shared/core/search';
import type { RemoteRoomSummary, SwitchServer } from '@shared/core/switch-servers/switch-servers';

/**
 * Re-ranks FTS5 results by boosting items belonging to the active location.
 * Applied to DB results only — actions are already ordered by context relevance.
 */
export function applyContextAffinity(
  items: SearchItem[],
  context: { locationId?: string }
): SearchItem[] {
  return [...items].sort((a, b) => {
    const boost = (x: SearchItem) =>
      x.locationId === context.locationId && context.locationId != null ? 1 : 0;
    const diff = boost(b) - boost(a);
    // BM25: lower (more negative) is better
    return diff !== 0 ? diff : a.score - b.score;
  });
}

/** The indexed kinds a search covers, for the hint under a too-short query. */
export function indexedSearchLabel(includeLegacy: boolean): string {
  return includeLegacy ? 'agents, sessions and commands' : 'commands';
}

/** The kinds matched from the first character, for the same hint. */
export function instantMatchLabel(includeLegacy: boolean): string {
  return includeLegacy ? 'Rooms, servers and hosts' : 'Agents, rooms, servers and hosts';
}

/** The search box's placeholder, naming only what the palette will find. */
export function paletteSearchPlaceholder(includeLegacy: boolean): string {
  return includeLegacy
    ? 'Search agents, sessions, rooms, servers, actions…'
    : 'Search agents, rooms, servers, actions…';
}

/** Per-kind cap for renderer-matched results. Enough to be useful, few enough
 *  that one kind cannot crowd out the rest of the palette. */
const RENDERER_RESULT_LIMIT = 8;

/**
 * Rank one renderer-matched candidate, or null when the text does not contain
 * the query.
 *
 * Graded the same way as the indexed kinds (see `matchQuality`) so the two
 * populations agree on what a match is and on which matches are better — a
 * palette where rooms and agents disagree about that would be incoherent to
 * use, whichever rule is the better one.
 *
 * `score` orders these against each other and nothing else. It is an ordinal,
 * not a BM25 rank, so renderer-matched kinds render in their own groups rather
 * than merged into the indexed results — the two number spaces are not
 * comparable, and pretending otherwise would quietly corrupt the ordering of
 * both.
 *
 * Unlike the indexed kinds these have no three-character floor, since nothing
 * here goes through the trigram tokenizer.
 */
function rank(haystack: string, query: string): number | null {
  switch (matchQuality(haystack, query)) {
    // Ties break on the shorter name, which is the more exact match.
    case 'prefix':
      return -haystack.length;
    case 'word':
      return 1000 + haystack.length;
    case 'substring':
      return 2000 + haystack.length;
    default:
      return null;
  }
}

function finalise(items: SearchItem[]): SearchItem[] {
  return items
    .sort((a, b) => a.score - b.score || a.title.localeCompare(b.title))
    .slice(0, RENDERER_RESULT_LIMIT);
}

function item(
  kind: SearchItemKind,
  id: string,
  title: string,
  subtitle: string,
  score: number
): SearchItem {
  return { kind, id, locationId: null, sessionId: null, title, subtitle, score };
}

/**
 * Matches the user's 1:1 chats with agents, by the chat's name and the agent's.
 * Drawn as chats (the item's `id` is the room); a chat the user no longer has
 * is not in the list, so it is not found.
 */
export function matchDirectChats(chats: ChatSummary[], query: string): SearchItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return finalise(
    chats.flatMap((chat) => {
      if (!isConsoleDirectChatSummary(chat)) return [];
      const agent = chat.agents[0] ? chatAgentLabel(chat.agents[0]) : '';
      const score = rank(chat.name, q) ?? rank(agent, q);
      return score === null ? [] : [item('session', chat.roomId, chat.name, agent, score)];
    })
  );
}

/** What an indexed search may show: no legacy agents or sessions when they are left out. */
export function withoutLegacy(items: SearchItem[], includeLegacy: boolean): SearchItem[] {
  return includeLegacy
    ? items
    : items.filter((each) => each.kind !== 'session' && each.kind !== 'agent');
}

/**
 * Matches Switch rooms, across every server rather than the active one — you
 * search because you do not know where a thing is. Selecting one switches the
 * active server so the sidebar follows.
 */
export function matchRooms(rooms: RemoteRoomSummary[], query: string): SearchItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  return finalise(
    rooms.flatMap((room) => {
      const score = rank(room.name, q);
      return score === null ? [] : [item('room', room.id, room.name, room.description, score)];
    })
  );
}

/**
 * Matches the active server's managed agents, by the name they are shown under
 * and by their Switch name. These are the agents under agent management; the
 * Console agents the index holds are the legacy ones.
 */
export function matchManagedAgents(agents: ManagedAgentView[], query: string): ManagedAgentView[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  return agents
    .flatMap((agent) => {
      const label = managedAgentLabel(agent);
      const score = rank(label, q) ?? rank(agent.name, q);
      return score === null ? [] : [{ agent, label, score }];
    })
    .sort((a, b) => a.score - b.score || a.label.localeCompare(b.label))
    .slice(0, RENDERER_RESULT_LIMIT)
    .map(({ agent }) => agent);
}

/** Matches Switch servers. Also matches on the server's address, since a server
 *  is as often recognised by where it lives as by what it was named. */
export function matchServers(servers: SwitchServer[], query: string): SearchItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  return finalise(
    servers.flatMap((server) => {
      const score = rank(server.name, q) ?? rank(server.url, q);
      return score === null ? [] : [item('server', server.id, server.name, server.url, score)];
    })
  );
}

/**
 * Matches onboarded remote hosts. The SSH alias is the host's identity (it is
 * the primary key), so it is matched as well as the display name — the alias is
 * usually what someone remembers.
 */
export function matchHosts(
  hosts: { sshHost: string; name: string }[],
  query: string
): SearchItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  return finalise(
    hosts.flatMap((host) => {
      const score = rank(host.name, q) ?? rank(host.sshHost, q);
      return score === null ? [] : [item('host', host.sshHost, host.name, host.sshHost, score)];
    })
  );
}

/**
 * Splits results into the sections the palette shows them under.
 *
 * The palette used to render indexed results ungrouped, after the room/server/
 * host groups. A cmdk heading belongs to a group, and an item outside one is a
 * sibling appended after the last group — so agents and sessions read as though
 * they were more servers. Every result now belongs to a section.
 *
 * Keyed by every kind rather than the three the index emits today, so a kind it
 * starts emitting lands in the section that already names it instead of
 * silently vanishing.
 */
export function sectionResults(items: SearchItem[]): Record<SearchItemKind, SearchItem[]> {
  const sections: Record<SearchItemKind, SearchItem[]> = {
    agent: [],
    session: [],
    command: [],
    room: [],
    server: [],
    host: [],
  };
  for (const entry of items) sections[entry.kind].push(entry);
  return sections;
}
