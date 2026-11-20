/**
 * Someone who can be put in a new room: an agent, or a person. A person from
 * the workspace has their Switch user id as `id`; one from a messaging app has
 * their username there. `userIds` are the Switch users a person is, so one can
 * be matched to the same person on another app; empty when nobody knows.
 */
export type Participant =
  | { kind: 'agent'; id: string; name: string; iconUrl: string | null; detail: string }
  | { kind: 'person'; id: string; name: string; detail: string; userIds?: string[] };

/** An agent the workspace lists, as a participant; `provider` names what runs it. */
export function agentParticipant(
  agent: { id: string; name: string; displayName: string | null; iconUrl: string | null },
  provider: string
): Participant {
  return {
    kind: 'agent',
    id: agent.id,
    name: agent.displayName ?? agent.name,
    iconUrl: agent.iconUrl,
    detail: `Agent · ${provider}`,
  };
}

/** A person from the workspace roster, as a participant, shown with their email. */
export function personParticipant(person: {
  userId: string;
  name: string;
  email: string | null;
}): Participant {
  return {
    kind: 'person',
    id: person.userId,
    name: person.name,
    detail: person.email ?? '',
    userIds: [person.userId],
  };
}

/**
 * Someone Switch knows on a messaging app, as a participant: by the name of
 * the Switch user who linked the account when there is one, and always with
 * the username the app knows them by, which is what the room is given.
 */
export function bridgePersonParticipant(person: {
  username: string;
  linkedUserIds: string[];
  linkedName: string | null;
}): Participant {
  return {
    kind: 'person',
    id: person.username,
    name: person.linkedName ?? person.username,
    detail: `@${person.username}`,
    userIds: person.linkedUserIds,
  };
}

/**
 * The picks to keep when the room moves to where `candidates` are offered:
 * every agent offered there, and each person who is the same Switch user as
 * one offered there, as that one. Anyone else is left out, and returned in
 * `dropped` so the dialog can say who.
 */
export function carryPicks(
  picked: readonly Participant[],
  candidates: readonly Participant[]
): { kept: Participant[]; dropped: Participant[] } {
  const kept: Participant[] = [];
  const dropped: Participant[] = [];
  for (const each of picked) {
    const match =
      each.kind === 'agent'
        ? candidates.find((candidate) => same(candidate, each))
        : candidates.find(
            (candidate) =>
              candidate.kind === 'person' &&
              (candidate.userIds ?? []).some((id) => (each.userIds ?? []).includes(id))
          );
    if (match && !kept.some((other) => same(other, match))) kept.push(match);
    else if (!match) dropped.push(each);
  }
  return { kept, dropped };
}

const same = (a: Participant, b: Participant) => a.kind === b.kind && a.id === b.id;

/** The candidates not yet picked whose name or detail (provider, email) contains the query. */
export function searchParticipants(
  candidates: readonly Participant[],
  picked: readonly Participant[],
  query: string
): Participant[] {
  const needle = query.trim().toLowerCase();
  return candidates.filter(
    (candidate) =>
      !picked.some((each) => same(each, candidate)) &&
      (needle === '' || `${candidate.name}\n${candidate.detail}`.toLowerCase().includes(needle))
  );
}

export type PickerKeyAction =
  | { type: 'move'; active: number }
  | { type: 'add' }
  | { type: 'removeLast' }
  | { type: 'close' }
  | null;

/** What a key in the search field does; null leaves it to the browser and the dialog. */
export function pickerKey(
  key: string,
  state: { query: string; open: boolean; active: number; results: number; picked: number }
): PickerKeyAction {
  const { query, open, active, results, picked } = state;
  switch (key) {
    case 'ArrowDown':
      return results > 0 ? { type: 'move', active: open ? (active + 1) % results : 0 } : null;
    case 'ArrowUp':
      return results > 0
        ? { type: 'move', active: open ? (active - 1 + results) % results : results - 1 }
        : null;
    case 'Enter':
      return open && results > 0 ? { type: 'add' } : null;
    case 'Backspace':
      return query === '' && picked > 0 ? { type: 'removeLast' } : null;
    case 'Escape':
      return open ? { type: 'close' } : null;
    default:
      return null;
  }
}
