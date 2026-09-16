import { load } from 'js-yaml';

/**
 * What a template document creates, for a listing card ("Creates 1 room and
 * 1 agent · 4 inputs") and a page's "What it creates" list. Three shapes:
 * an agent template (`agent:` with an optional `room:`), a room template
 * (`room:` with `params:`), and a group (`agents:` and/or `group:` +
 * `rooms:`), which makes several things at once.
 */
export type TemplateSummary = {
  kind: 'agent' | 'room' | 'group';
  rooms: number;
  agents: number;
  inputs: number;
  /** Each thing it creates, in the order the page lists them: rooms, then agents. */
  creates: CreatedThing[];
};

export type CreatedThing = {
  kind: 'room' | 'agent';
  /** The name as the template spells it, placeholders and all. */
  label: string;
  /** Its description, or a line about it when the template gives none. */
  note: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function agentsOf(room: Record<string, unknown> | null): string[] {
  if (!room) return [];
  const raw = room.agents;
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => {
    const r = asRecord(a);
    return String(r?.name ?? a);
  });
}

function roomThing(room: Record<string, unknown>): CreatedThing {
  const members = agentsOf(room);
  const note =
    str(room.description) ||
    (members.length > 0 ? `With ${members.join(', ')}` : 'A room with nobody in it yet');
  return { kind: 'room', label: str(room.name) || 'Unnamed room', note };
}

export function summarizeTemplate(yamlText: string): TemplateSummary {
  let doc: unknown;
  try {
    doc = load(yamlText);
  } catch {
    doc = null;
  }
  const root = asRecord(doc) ?? {};
  const inputs = Object.keys(asRecord(root.params) ?? {}).length;

  const agentEntries: Record<string, unknown>[] = Array.isArray(root.agents)
    ? root.agents.map(asRecord).filter((a): a is Record<string, unknown> => !!a)
    : asRecord(root.agent)
      ? [asRecord(root.agent) as Record<string, unknown>]
      : [];
  const roomEntries: Record<string, unknown>[] = Array.isArray(root.rooms)
    ? root.rooms.map(asRecord).filter((r): r is Record<string, unknown> => !!r)
    : asRecord(root.room)
      ? [asRecord(root.room) as Record<string, unknown>]
      : [];
  const isGroup = root.group !== undefined || Array.isArray(root.rooms) || agentEntries.length > 1;

  const creates: CreatedThing[] = [
    ...roomEntries.map(roomThing),
    ...agentEntries.map((a) => ({
      kind: 'agent' as const,
      label: str(a.name) || 'Named when created',
      note: str(a.description) || 'An agent with its own instructions',
    })),
  ];

  if (agentEntries.length > 0) {
    // The agents a room lists are the ones the template makes; other names
    // are agents the server must already have, not created.
    return {
      kind: isGroup ? 'group' : 'agent',
      rooms: roomEntries.length,
      agents: agentEntries.length,
      inputs,
      creates,
    };
  }
  // A room document names agents the server already has; it creates none.
  if (isGroup) {
    return { kind: 'group', rooms: roomEntries.length, agents: 0, inputs, creates };
  }
  return {
    kind: 'room',
    rooms: 1,
    agents: 0,
    inputs,
    creates: roomEntries.length > 0 ? creates : [],
  };
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** The card line: "Creates 1 room and 2 agents · 4 inputs". */
export function describeSummary(s: TemplateSummary): { creates: string; inputs: string } {
  const parts: string[] = [];
  if (s.rooms > 0) parts.push(plural(s.rooms, 'room'));
  if (s.agents > 0) parts.push(plural(s.agents, 'agent'));
  const creates = parts.length > 0 ? `Creates ${parts.join(' and ')}` : 'Creates nothing yet';
  const inputs = s.inputs === 0 ? 'no inputs' : plural(s.inputs, 'input');
  return { creates, inputs };
}
