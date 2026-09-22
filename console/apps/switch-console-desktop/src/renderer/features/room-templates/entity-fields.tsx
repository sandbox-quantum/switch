import { useQuery } from '@tanstack/react-query';
import { User as UserIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  type AgentPick,
  AgentPickerRow,
  ChosenAgentTile,
  agentProviderLabelFor,
} from '@renderer/lib/components/agent-picker';
import { BridgeTile, bridgeUnusableReason } from '@renderer/lib/components/bridge-tile';
import { ChosenTile } from '@renderer/lib/components/chosen-tile';
import { PickerCombobox } from '@renderer/lib/components/picker-combobox';
import { ChosenRoomTile, type RoomPick, RoomPickerRow } from '@renderer/lib/components/room-picker';
import { useDebounce } from '@renderer/lib/hooks/useDebounce';
import { rpc } from '@renderer/lib/ipc';
import type {
  LinkedIdentity,
  RemoteBridge,
  RemoteExternalUser,
} from '@shared/core/switch-servers/switch-servers';

/**
 * Everything the server has that a template can point at, read once by the
 * wizard and handed to every field that offers a choice from it.
 */
export type EntityLists = {
  serverId: string;
  agents: AgentPick[];
  agentsLoading: boolean;
  rooms: RoomPick[];
  roomsLoading: boolean;
  bridges: RemoteBridge[];
  /** Null while the signed-in user's linked accounts are unknown. */
  identities: LinkedIdentity[] | null;
  /** Platform users Switch has already seen on this server. */
  knownUsers: RemoteExternalUser[];
  /** The bridge the room will land on, for directory lookups. Null when the
   * template leaves it open and the server has no default. */
  bridgeId: string | null;
};

const NOT_ON_SERVER = 'Not on this server';

/** The grid every chosen tile sits in, so single picks and lists line up. */
export function TileGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-3 gap-2.5">{children}</div>;
}

// ── Agents ──────────────────────────────────────────────────────────────────

function agentTileFor(name: string, lists: EntityLists, onRemove: () => void) {
  const found = lists.agents.find((a) => a.name === name);
  return found ? (
    <ChosenAgentTile
      key={name}
      agent={found}
      subtitle={agentProviderLabelFor(found.id, lists.serverId)}
      onRemove={onRemove}
    />
  ) : (
    <ChosenAgentTile
      key={name}
      agent={{ id: name, name, iconUrl: null }}
      subtitle={NOT_ON_SERVER}
      subtitleTone="warning"
      onRemove={onRemove}
    />
  );
}

function AgentCombobox({
  lists,
  exclude,
  onPick,
}: {
  lists: EntityLists;
  exclude: string[];
  onPick: (name: string) => void;
}) {
  const items = lists.agents.filter((a) => !exclude.includes(a.name));
  return (
    <PickerCombobox
      items={items}
      onPick={(agent) => onPick(agent.name)}
      searchText={(agent) => agent.name}
      renderItem={(agent) => (
        <AgentPickerRow agent={agent} subtitle={agentProviderLabelFor(agent.id, lists.serverId)} />
      )}
      disabled={lists.agentsLoading}
      placeholder={lists.agentsLoading ? 'Loading agents…' : 'Search agents…'}
      emptyText="No agents found"
    />
  );
}

/** One agent, by name: a search box until picked, then the agent's tile. */
export function AgentField({
  value,
  onChange,
  lists,
}: {
  value: string;
  onChange: (name: string) => void;
  lists: EntityLists;
}) {
  if (value === '') return <AgentCombobox lists={lists} exclude={[]} onPick={onChange} />;
  return <TileGrid>{agentTileFor(value, lists, () => onChange(''))}</TileGrid>;
}

/**
 * A list of agents by name, each a tile, with a search box to add more.
 *
 * The template's fixed `agents:` come in pre-filled. A name the server does
 * not know stays in the list and says so on its tile, so the person can drop
 * it rather than find out from a failed create.
 */
export function AgentListField({
  items,
  onChange,
  lists,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  lists: EntityLists;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      {items.length > 0 && (
        <TileGrid>
          {items.map((name) =>
            agentTileFor(name, lists, () => onChange(items.filter((n) => n !== name)))
          )}
        </TileGrid>
      )}
      <AgentCombobox lists={lists} exclude={items} onPick={(name) => onChange([...items, name])} />
    </div>
  );
}

// ── Rooms ───────────────────────────────────────────────────────────────────

/** One existing room, by name: a search box until picked, then its tile. */
export function RoomField({
  value,
  onChange,
  lists,
}: {
  value: string;
  onChange: (name: string) => void;
  lists: EntityLists;
}) {
  if (value === '') {
    return (
      <PickerCombobox
        items={lists.rooms}
        onPick={(room) => onChange(room.name)}
        searchText={(room) => room.name}
        renderItem={(room) => <RoomPickerRow room={room} />}
        disabled={lists.roomsLoading}
        placeholder={lists.roomsLoading ? 'Loading rooms…' : 'Search rooms…'}
        emptyText="No rooms found"
      />
    );
  }
  const found = lists.rooms.find((r) => r.name === value);
  return (
    <TileGrid>
      {found ? (
        <ChosenRoomTile room={found} onRemove={() => onChange('')} />
      ) : (
        <ChosenRoomTile
          room={{ id: value, name: value, bridgeType: null }}
          subtitle={NOT_ON_SERVER}
          subtitleTone="warning"
          onRemove={() => onChange('')}
        />
      )}
    </TileGrid>
  );
}

// ── Bridges ─────────────────────────────────────────────────────────────────

/**
 * One messaging app, by display name, from the same tile grid the new-room
 * dialog uses. The room's channel is created wherever the template says, so
 * only a running app is selectable; a stopped one is shown and says so.
 */
export function BridgeField({
  value,
  onChange,
  lists,
}: {
  value: string;
  onChange: (displayName: string) => void;
  lists: EntityLists;
}) {
  const unknown = value !== '' && !lists.bridges.some((b) => b.displayName === value);
  return (
    <div className="flex flex-col gap-2">
      {lists.bridges.length > 0 ? (
        <div className="grid grid-cols-2 gap-2.5">
          {lists.bridges.map((bridge) => (
            <BridgeTile
              key={bridge.id}
              bridge={bridge}
              identity={lists.identities?.find((i) => i.bridgeId === bridge.id) ?? null}
              identitiesKnown={lists.identities !== null}
              unusable={bridgeUnusableReason(bridge, { needsChannelCreation: false })}
              selected={value === bridge.displayName}
              onSelect={() => onChange(bridge.displayName)}
            />
          ))}
        </div>
      ) : (
        <p className="text-xs text-foreground-muted">
          This server has no messaging app connected, so there is nothing to choose from.
        </p>
      )}
      {unknown && (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          The template names <strong>{value}</strong>, which is not a messaging app on this server.
          Pick one above.
        </p>
      )}
    </div>
  );
}

// ── Users ───────────────────────────────────────────────────────────────────

type UserCandidate = {
  id: string;
  username: string;
  /** Where the row came from, for the right of the row. */
  source: 'known' | 'directory' | 'typed';
  displayName: string | null;
};

/** How long to wait after the last keystroke before asking the platform. Every
 * search is a live call out to Slack or Mattermost, so this is a courtesy to
 * their rate limits as much as to ours. */
const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

function userSourceLabel(candidate: UserCandidate): string {
  switch (candidate.source) {
    case 'known':
      return 'Known';
    case 'directory':
      return candidate.displayName ?? 'Directory';
    case 'typed':
      return 'Use as typed';
  }
}

/**
 * Pick a person by platform username.
 *
 * Three sources feed the list: the users Switch has already seen on this
 * server, a live search of the messaging app's directory once two characters
 * are typed, and the typed text itself, offered last. The last one is there
 * because the server looks an unseen name up in the directory when it creates
 * the room, so a name the search did not surface is not necessarily wrong.
 */
function UserCombobox({
  lists,
  exclude,
  onPick,
}: {
  lists: EntityLists;
  exclude: string[];
  onPick: (username: string) => void;
}) {
  const [query, setQuery] = useState('');
  const debounced = useDebounce(query.trim(), SEARCH_DEBOUNCE_MS);
  const bridgeId = lists.bridgeId;
  const searchable = bridgeId !== null && debounced.length >= MIN_QUERY_LENGTH;
  const directory = useQuery({
    queryKey: ['bridge-directory', lists.serverId, bridgeId, debounced],
    queryFn: () =>
      rpc.switchServers.searchBridgeDirectory({
        serverId: lists.serverId,
        bridgeId: bridgeId as string,
        query: debounced,
      }),
    enabled: searchable,
  });

  const items = useMemo((): UserCandidate[] => {
    const seen = new Set<string>(exclude);
    const out: UserCandidate[] = [];
    for (const user of lists.knownUsers) {
      if (seen.has(user.username)) continue;
      seen.add(user.username);
      out.push({
        id: `known:${user.id}`,
        username: user.username,
        source: 'known',
        displayName: null,
      });
    }
    if (directory.data?.kind === 'results') {
      for (const person of directory.data.users) {
        if (seen.has(person.username)) continue;
        seen.add(person.username);
        out.push({
          id: `directory:${person.externalUserId}`,
          username: person.username,
          source: 'directory',
          displayName: person.displayName || null,
        });
      }
    }
    const typed = query.trim();
    if (typed !== '' && !seen.has(typed)) {
      out.push({ id: `typed:${typed}`, username: typed, source: 'typed', displayName: null });
    }
    return out;
  }, [lists.knownUsers, directory.data, query, exclude]);

  return (
    <PickerCombobox
      items={items}
      onPick={(candidate) => onPick(candidate.username)}
      onQueryChange={setQuery}
      searchText={(candidate) =>
        `${candidate.username} ${candidate.displayName ?? ''}`.toLowerCase()
      }
      renderItem={(candidate) => (
        <>
          <UserIcon className="size-4 shrink-0 text-foreground-muted" />
          <span className="min-w-0 flex-1 truncate">{candidate.username}</span>
          <span className="shrink-0 text-xs text-foreground-muted">
            {userSourceLabel(candidate)}
          </span>
        </>
      )}
      placeholder={bridgeId === null ? 'Username (no messaging app to search)' : 'Search people…'}
      emptyText="Type a username"
    />
  );
}

function userTileFor(username: string, lists: EntityLists, onRemove: () => void) {
  const known = lists.knownUsers.some((u) => u.username === username);
  return (
    <ChosenTile
      key={username}
      mark={<UserIcon className="size-5 text-foreground-muted" />}
      title={username}
      subtitle={known ? 'Known to this server' : 'Looked up when the room is created'}
      onRemove={onRemove}
    />
  );
}

/** One person, by platform username: a search box until picked, then a tile. */
export function UserField({
  value,
  onChange,
  lists,
}: {
  value: string;
  onChange: (username: string) => void;
  lists: EntityLists;
}) {
  if (value === '') return <UserCombobox lists={lists} exclude={[]} onPick={onChange} />;
  return <TileGrid>{userTileFor(value, lists, () => onChange(''))}</TileGrid>;
}

/** A list of people by username, each a tile, with a search box to add more. */
export function UserListField({
  items,
  onChange,
  lists,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  lists: EntityLists;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      {items.length > 0 && (
        <TileGrid>
          {items.map((name) =>
            userTileFor(name, lists, () => onChange(items.filter((n) => n !== name)))
          )}
        </TileGrid>
      )}
      <UserCombobox lists={lists} exclude={items} onPick={(name) => onChange([...items, name])} />
    </div>
  );
}
