import { load } from 'js-yaml';

/**
 * What a template document creates, counted for a listing card: "Creates 1
 * room and 1 agent · 4 inputs". Three shapes are known: an agent template
 * (`agent:` with an optional `room:`), a room template (`room:` with
 * `params:`), and a group template (`rooms:`), which another branch is
 * adding; counting it here means its cards read right the day it lands.
 */
export type TemplateSummary = {
  kind: 'agent' | 'room' | 'group';
  rooms: number;
  agents: number;
  inputs: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function countList(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
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

export function summarizeTemplate(yamlText: string): TemplateSummary {
  let doc: unknown;
  try {
    doc = load(yamlText);
  } catch {
    doc = null;
  }
  const root = asRecord(doc) ?? {};
  const inputs = Object.keys(asRecord(root.params) ?? {}).length;

  if (root.agent !== undefined) {
    const room = asRecord(root.room);
    // The template's own agent is the `{agent}` entry in its room; other
    // agents it names are ones the server must already have, not created.
    return { kind: 'agent', rooms: room ? 1 : 0, agents: 1, inputs };
  }
  if (Array.isArray(root.rooms)) {
    const names = new Set<string>();
    for (const r of root.rooms) for (const a of agentsOf(asRecord(r))) names.add(a);
    return {
      kind: 'group',
      rooms: countList(root.rooms),
      agents: names.size,
      inputs,
    };
  }
  return {
    kind: 'room',
    rooms: 1,
    agents: agentsOf(asRecord(root.room)).length,
    inputs,
  };
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** The card line: "Creates 1 room and 2 agents · 4 inputs". */
export function describeSummary(s: TemplateSummary): {
  creates: string;
  inputs: string;
} {
  const parts: string[] = [];
  if (s.rooms > 0) parts.push(plural(s.rooms, 'room'));
  if (s.agents > 0) parts.push(plural(s.agents, 'agent'));
  const creates = parts.length > 0 ? `Creates ${parts.join(' and ')}` : 'Creates nothing yet';
  const inputs = s.inputs === 0 ? 'no inputs' : plural(s.inputs, 'input');
  return { creates, inputs };
}
