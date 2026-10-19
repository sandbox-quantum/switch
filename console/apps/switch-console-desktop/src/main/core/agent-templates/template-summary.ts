import { load } from 'js-yaml';

/**
 * What a template document creates: the counts a listing card shows
 * ("Creates 1 room and 1 agent · 4 inputs") and the rooms and agents a
 * template page lists under "What it creates".
 */
export type TemplateSummary = {
  kind: 'agent' | 'room' | 'group';
  rooms: number;
  agents: number;
  inputs: number;
  /** Each room and agent it creates, rooms first. */
  creates: TemplateEntity[];
};

export type TemplateEntity = {
  kind: 'room' | 'agent';
  /** As written in the template, with any `{param}` still unfilled. */
  name: string;
  /** From the template, or a generated line when it has none. */
  description: string;
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

function roomThing(room: Record<string, unknown>): TemplateEntity {
  const members = agentsOf(room);
  const description =
    str(room.description) ||
    (members.length > 0 ? `With ${members.join(', ')}` : 'A room with nobody in it yet');
  return { kind: 'room', name: str(room.name) || 'Unnamed room', description };
}

export function summarizeTemplate(yamlText: string): TemplateSummary {
  // Text that is not YAML is summarized as one empty room, so the listing
  // card still renders; the Use page reports the parse error.
  let doc: unknown;
  try {
    doc = load(yamlText);
  } catch {
    doc = null;
  }
  const root = asRecord(doc) ?? {};
  if (root.version === 2) return summarizeVersion2(root);
  // Only params the deployer has to answer: no default to prefill from, and
  // not marked optional. A chain default counts as a default here, since a
  // server with the first candidate set up asks nothing.
  const inputs = Object.values(asRecord(root.params) ?? {}).filter((spec) => {
    const record = asRecord(spec);
    return record?.default === undefined && record?.required !== false;
  }).length;

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

  const creates: TemplateEntity[] = [
    ...roomEntries.map(roomThing),
    ...agentEntries.map((a) => ({
      kind: 'agent' as const,
      name: str(a.name) || 'Named when created',
      description: str(a.description) || 'An agent with its own instructions',
    })),
  ];

  if (agentEntries.length > 0) {
    // Only the entries under `agent:` or `agents:` are created. Other names in
    // a room's list refer to agents the server must already have.
    return {
      kind: isGroup ? 'group' : 'agent',
      rooms: roomEntries.length,
      agents: agentEntries.length,
      inputs,
      creates,
    };
  }
  // A room or group document without `agents:` creates no agents. The names
  // in its rooms refer to agents the server already has.
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

/**
 * A version 2 document says what it creates under `resources:`, each with a
 * type. A resource with an `if:` is created only for some answers, and a
 * param with one is asked only for some, so neither is counted: the card
 * says what every run creates and what every run asks.
 */
function summarizeVersion2(root: Record<string, unknown>): TemplateSummary {
  const resources = Object.entries(asRecord(root.resources) ?? {}).flatMap(([key, value]) => {
    const r = asRecord(value);
    return r ? [{ key, r }] : [];
  });
  const always = resources.filter(({ r }) => r.if === undefined);
  const ofType = (list: typeof resources, type: string) => list.filter(({ r }) => r.type === type);
  // As for version 1: params with no default to prefill from, not marked optional.
  const inputs = Object.values(asRecord(root.params) ?? {}).filter((spec) => {
    const record = asRecord(spec);
    return record?.if === undefined && record?.default === undefined && record?.required !== false;
  }).length;
  const name = (key: string, r: Record<string, unknown>) =>
    str(r.name) || str(r.display_name) || key;
  const rooms = ofType(resources, 'room');
  const agents = ofType(resources, 'agent');
  const described = (r: Record<string, unknown>, fallback: string) => {
    const text = str(r.description) || fallback;
    return r.if === undefined
      ? text
      : `${text.replace(/\.?$/, '.')} Created only for some answers.`;
  };
  const creates: TemplateEntity[] = [
    ...rooms.map(({ key, r }) => ({
      kind: 'room' as const,
      name: name(key, r),
      description: described(r, 'A room'),
    })),
    ...agents.map(({ key, r }) => ({
      kind: 'agent' as const,
      name: name(key, r),
      description: described(r, 'An agent with its own instructions'),
    })),
  ];
  const roomCount = ofType(always, 'room').length;
  const agentCount = ofType(always, 'agent').length;
  const kind =
    ofType(resources, 'group').length > 0 || roomCount > 1 || agents.length > 1
      ? 'group'
      : agents.length > 0
        ? 'agent'
        : 'room';
  return { kind, rooms: roomCount, agents: agentCount, inputs, creates };
}
