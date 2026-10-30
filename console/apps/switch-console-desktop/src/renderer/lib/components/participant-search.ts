/** Someone who can be put in a new room: an agent, or a person from the workspace. */
export type Participant =
  | { kind: 'agent'; id: string; name: string; iconUrl: string | null; detail: string }
  | { kind: 'person'; id: string; name: string; detail: string };

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
  return { kind: 'person', id: person.userId, name: person.name, detail: person.email ?? '' };
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
