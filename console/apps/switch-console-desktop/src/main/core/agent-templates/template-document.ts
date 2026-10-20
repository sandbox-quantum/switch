import { dump, load } from 'js-yaml';
import {
  CONSOLE_PARAM_TYPES,
  type ConsoleParamType,
} from '@shared/core/switch-servers/room-template-params';
import {
  type AgentTemplateAddressing,
  type AgentTemplateSource,
  extractSources,
  optionalString,
  type ParsedAgentTemplate,
  stripFrontMatter,
} from './agent-template-format';

/**
 * Helpers for a template document.
 *
 * The Console creates the agents listed under `agent:` or `agents:`, because
 * an agent runs on a machine the Console can reach and the server cannot.
 * The server creates the rooms under `room:`, or `group:` with `rooms:`,
 * through `POST /rooms/from-yaml`.
 *
 * A room's `agents:` list refers to those agents by the text written in the
 * template, `{team}-triager` for example, before any `{param}` is filled in.
 * The helpers here compare that unfilled text to match a room entry with
 * the agent it refers to.
 *
 * `switch-expert/template.yaml` at the repository root documents every field.
 */
export type TemplateKind = 'agent' | 'room' | 'group';

/** A connection a template grants an agent: the deployer's own connection to `service`. */
export type TemplateConnection = {
  service: string;
  /** Null for the level a new grant takes by default. */
  access: 'read' | 'write' | null;
  /** GitHub only: the repositories it reaches, `owner/name`. */
  repos: string[];
};

export type ParsedAgentEntry = {
  /** The name as written in the template, with any `{param}` still unfilled. */
  name: string | null;
  /** How the agent is shown to people, when the template gives one. */
  displayName: string | null;
  description: string;
  instructions: string;
  repoUrl: string | null;
  sources: AgentTemplateSource[];
  addressing: AgentTemplateAddressing | null;
  /**
   * Which coding agent runs it. Either a provider id (`claude`, `codex`,
   * `opencode`) or a `{param}` whose value is one. Null when the template
   * has no `provider` field.
   */
  provider: string | null;
  /** Where it runs: `local`, an ssh host, or a `{param}`. Null when the template has no `location` field. */
  location: string | null;
  /**
   * Where it runs as one of the owner's machines on the server: a machine's
   * name or id, or a `{param}`. Null when the template has no `machine` field.
   */
  machine: string | null;
  /** The model to run, or a `{param}`; null for the provider's default. */
  model: string | null;
  /** The provider's advanced settings, as written; `{param}`s still unfilled. */
  advancedConfig: Record<string, unknown>;
  /** `shared` or `isolated`, or a `{param}`; null for shared. */
  isolation: string | null;
  /** The provider's own automatic review: `true`, `false`, or a `{param}`; null for true. */
  autoMode: boolean | string | null;
  /** Run tools without asking: `true`, `false`, or a `{param}`; null for false. */
  autoApprove: boolean | string | null;
  /** The deployer's connections it is granted, as written. */
  connections: TemplateConnection[];
  /** Its working directory, or a `{param}`. Null when the template has no `directory` field. */
  directory: string | null;
  /** Rooms the agent is added to once it exists, by name or `{param}`. */
  join: string[];
  /** Every `{name}` written anywhere in the entry, its instructions included. */
  placeholders: string[];
  /**
   * Whether the deployer may fill this entry with an agent the server already
   * has instead of creating it. From `allow_existing:`, false unless the
   * template says so.
   */
  allowExisting: boolean;
  /** A version 2 resource's key; null in a version 1 document. */
  key: string | null;
  /** A version 2 resource's `if:`: created only while it holds. */
  condition: string | null;
};

/**
 * What runs an agent, where, and in which folder: what a template must say
 * for every agent it creates. Where it runs is said with `location` or
 * `machine`; `location` stands for both.
 */
export type RuntimeField = 'provider' | 'location' | 'directory';
export const RUNTIME_FIELDS: readonly RuntimeField[] = ['provider', 'location', 'directory'];

/** The fields, and param types, that say each runtime setting. */
const RUNTIME_KINDS: Record<RuntimeField, readonly string[]> = {
  provider: ['provider'],
  location: ['location', 'machine'],
  directory: ['directory'],
};

/** A runtime setting the document never gives one of its agents. */
export type UnsaidRuntime = {
  /** The index of the agent entry. */
  index: number;
  /** How the entry is named in the document, for a message. */
  label: string;
  field: RuntimeField;
};

export type TemplateAgents = {
  agents: ParsedAgentEntry[];
  /**
   * True when the document uses the singular `agent:` form. That form has
   * one extra convention: its room refers to the agent as `{agent}`, and the
   * Console fills that in with the agent's final name.
   */
  singular: boolean;
  warnings: string[];
  /**
   * The runtime settings the document leaves unsaid. The Console supplies
   * none of its own, so the editor warns about each and the Use page refuses
   * to create until the document says it.
   */
  unsaid: UnsaidRuntime[];
};

const ADDRESSING_VALUES: ReadonlySet<string> = new Set(['owner', 'owner-agents', 'anyone']);

export function parseYaml(yamlText: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = load(yamlText);
  } catch (e) {
    throw new Error(`Invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('Template must be a YAML mapping');
  }
  return doc as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Whether a document is written in version 2 of the language: resources with a key and a type. */
export function isVersion2(doc: Record<string, unknown>): boolean {
  return doc.version === 2 || asRecord(doc.resources) !== null;
}

/** A version 2 document's resources of one type, with their keys. */
function resourcesOf(
  doc: Record<string, unknown>,
  type: 'agent' | 'room' | 'group'
): [string, Record<string, unknown>][] {
  return Object.entries(asRecord(doc.resources) ?? {})
    .map(([key, spec]) => [key, asRecord(spec)] as const)
    .filter((e): e is [string, Record<string, unknown>] => e[1] !== null && e[1].type === type);
}

/** The agent entries as parsed YAML objects, from `agents:` (a list) or `agent:` (a single entry). */
function rawAgents(doc: Record<string, unknown>): Record<string, unknown>[] {
  if (isVersion2(doc)) return resourcesOf(doc, 'agent').map(([key, spec]) => ({ ...spec, key }));
  if (Array.isArray(doc.agents)) {
    return doc.agents.map((a) => asRecord(a)).filter((a): a is Record<string, unknown> => !!a);
  }
  const one = asRecord(doc.agent);
  return one ? [one] : [];
}

/**
 * Classify a document. `group`: it has `group:` or `rooms:`, or more than
 * one agent. `agent`: one agent, with or without a room. `room`: a room and
 * no agents.
 */
export function templateKind(yamlText: string): TemplateKind {
  return kindOf(parseYaml(yamlText));
}

export function kindOf(doc: Record<string, unknown>): TemplateKind {
  if (isVersion2(doc)) {
    const rooms = resourcesOf(doc, 'room').length;
    const agentCount = resourcesOf(doc, 'agent').length;
    if (resourcesOf(doc, 'group').length > 0 || rooms > 1 || agentCount > 1) return 'group';
    return agentCount === 1 ? 'agent' : 'room';
  }
  const agents = rawAgents(doc);
  if (doc.group !== undefined || Array.isArray(doc.rooms)) return 'group';
  if (agents.length > 1) return 'group';
  if (agents.length === 1) return 'agent';
  return 'room';
}

/**
 * Parse every agent entry of a document.
 *
 * `fallbackInstructions` is used when a single `agent:` has no
 * `instructions:` of its own. The bundled Switch expert is the case: its
 * instructions live in `AGENT.md` next to the template rather than inside
 * it, and the Console passes that file's content here.
 */
export function parseTemplateAgents(
  yamlText: string,
  fallbackInstructions: string | null = null
): TemplateAgents {
  const doc = parseYaml(yamlText);
  const entries = rawAgents(doc);
  const warnings: string[] = [];
  if (Array.isArray(doc.agents) && entries.length !== doc.agents.length) {
    warnings.push('Every entry of `agents:` must be a mapping with a `name:`.');
  }
  const hasRoom = asRecord(doc.room) !== null || Array.isArray(doc.rooms);
  if (typeof doc.kickoff === 'string' && !hasRoom) {
    warnings.push('`kickoff:` needs a `room:` to be posted into; without one it is ignored.');
  }
  const agents = entries.map((agent, i) => {
    const label = entries.length === 1 ? '`agent:`' : `agent ${i + 1}`;
    const inline =
      typeof agent.instructions === 'string' && agent.instructions.trim().length > 0
        ? agent.instructions
        : entries.length === 1
          ? (fallbackInstructions ?? '')
          : '';
    const instructions = stripFrontMatter(inline);
    if (instructions.trim().length === 0) {
      throw new Error(`${label} needs "instructions:" — the agent has nothing to go on.`);
    }
    if (typeof agent.kickoff === 'string' || typeof agent.room === 'object') {
      warnings.push('`room:` and `kickoff:` belong at the top level, beside `agent:`.');
    }
    const addressing = optionalString(agent.addressing);
    if (addressing !== null && !ADDRESSING_VALUES.has(addressing)) {
      warnings.push(
        `\`addressing: ${addressing}\` is not one of owner, owner-agents, anyone; the agent will answer only its owner.`
      );
    }
    return {
      name: optionalString(agent.name),
      displayName: optionalString(agent.display_name),
      description: typeof agent.description === 'string' ? agent.description.trim() : '',
      instructions,
      repoUrl: optionalString(agent.repo),
      sources: extractSources(agent.sources),
      addressing: ADDRESSING_VALUES.has(addressing ?? '')
        ? (addressing as AgentTemplateAddressing)
        : null,
      provider: optionalString(agent.provider),
      location: optionalString(agent.location),
      machine: optionalString(agent.machine),
      model: optionalString(agent.model),
      advancedConfig: asRecord(agent.advanced_config) ?? {},
      isolation: optionalString(agent.isolation),
      autoMode:
        typeof agent.auto_mode === 'boolean' ? agent.auto_mode : optionalString(agent.auto_mode),
      autoApprove:
        typeof agent.auto_approve === 'boolean'
          ? agent.auto_approve
          : optionalString(agent.auto_approve),
      connections: parseConnections(agent.connections, warnings, label),
      directory: optionalString(agent.directory),
      join: Array.isArray(agent.join)
        ? agent.join.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
        : [],
      placeholders: [...placeholdersIn({ ...agent, key: undefined })],
      allowExisting: agent.allow_existing === true,
      key: typeof agent.key === 'string' ? agent.key : null,
      condition: typeof agent.if === 'string' ? agent.if : null,
    };
  });
  return {
    agents,
    singular: !isVersion2(doc) && !Array.isArray(doc.agents) && agents.length === 1,
    warnings,
    unsaid: unsaidRuntime(doc, agents),
  };
}

/**
 * The provider, location and directory each agent entry leaves unsaid.
 *
 * An entry says one by its own field (a literal or a `{param}`), or the
 * document says it for every agent with a param of that type that no entry's
 * field reads.
 */
function unsaidRuntime(doc: Record<string, unknown>, agents: ParsedAgentEntry[]): UnsaidRuntime[] {
  const params = asRecord(doc.params) ?? {};
  const fieldTexts = agents.flatMap((a) => runtimeFieldTexts(a));
  const appliesToAll = (field: RuntimeField) =>
    Object.entries(params).some(
      ([name, spec]) =>
        RUNTIME_KINDS[field].includes(String(asRecord(spec)?.type)) &&
        !fieldTexts.some((t) => t.includes(`{${name}}`))
    );
  const says = (agent: ParsedAgentEntry, field: RuntimeField) =>
    RUNTIME_KINDS[field].some((kind) => agent[kind as keyof ParsedAgentEntry] !== null);
  const out: UnsaidRuntime[] = [];
  agents.forEach((agent, index) => {
    const label = agent.name ?? agent.displayName ?? `agent ${index + 1}`;
    for (const field of RUNTIME_FIELDS) {
      if (!says(agent, field) && !appliesToAll(field)) out.push({ index, label, field });
    }
  });
  return out;
}

/** The texts of an entry's runtime fields, for telling whether a param is read by one. */
export function runtimeFieldTexts(
  agent: Pick<ParsedAgentEntry, 'provider' | 'location' | 'machine' | 'directory'>
): string[] {
  return [agent.provider ?? '', agent.location ?? '', agent.machine ?? '', agent.directory ?? ''];
}

const ACCESS_VALUES: ReadonlySet<string> = new Set(['read', 'write']);

function parseConnections(raw: unknown, warnings: string[], label: string): TemplateConnection[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push(`${label}: \`connections:\` is a list of services.`);
    return [];
  }
  const out: TemplateConnection[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim() !== '') {
      out.push({ service: item.trim(), access: null, repos: [] });
      continue;
    }
    const record = asRecord(item);
    const service = optionalString(record?.service);
    if (!record || !service) {
      warnings.push(`${label}: each connection is a service name or {service, access, repos}.`);
      continue;
    }
    const access = optionalString(record.access);
    if (access !== null && !ACCESS_VALUES.has(access)) {
      warnings.push(`${label}: ${service} access '${access}' is not read or write.`);
    }
    const repos = Array.isArray(record.repos)
      ? record.repos.filter((r): r is string => typeof r === 'string' && r.trim() !== '')
      : typeof record.repos === 'string'
        ? [record.repos]
        : [];
    out.push({
      service,
      access: access === 'read' || access === 'write' ? access : null,
      repos,
    });
  }
  return out;
}

/** How the Use page lays out what the template folds away. From the document's `form:` block. */
export type FormOptions = {
  advanced: {
    /** The heading of the fold that holds the `input: advanced` and `input: fixed` params. */
    label: string;
    /** Whether the fold starts open. */
    open: boolean;
  };
};

export function formOptions(yamlText: string): FormOptions {
  const form = asRecord(parseYaml(yamlText).form);
  const advanced = asRecord(form?.advanced);
  return {
    advanced: {
      label: optionalString(advanced?.label) ?? 'Advanced',
      open: advanced?.open === true,
    },
  };
}

/**
 * The single-agent view of a document: the first agent entry and the room it
 * is put in. What the agent's settings page reads when it offers the
 * template's current instructions. Same parse as `parseTemplateAgents`.
 */
export function parseAgentTemplate(
  yamlText: string,
  fallbackInstructions: string | null = null
): ParsedAgentTemplate {
  const doc = parseYaml(yamlText);
  if (isVersion2(doc)) {
    const { agents, warnings } = parseTemplateAgents(yamlText, fallbackInstructions);
    if (agents.length !== 1)
      throw new Error(
        'This template creates several agents, so it has no single set of instructions to offer.'
      );
    const [agent] = agents;
    const [first] = resourcesOf(doc, 'room');
    return {
      name: agent!.name,
      addressing: agent!.addressing,
      description: agent!.description,
      instructions: agent!.instructions,
      repoUrl: agent!.repoUrl,
      sources: agent!.sources,
      room: first
        ? { name: optionalString(first[1].name), kickoff: optionalString(first[1].kickoff) }
        : null,
      provider: agent!.provider,
      warnings,
    };
  }
  if (asRecord(doc.agent) === null) {
    throw new Error(
      Array.isArray(doc.agents)
        ? 'This template creates several agents, so it has no single set of instructions to offer.'
        : 'Template must have an "agent:" block.'
    );
  }
  const { agents, warnings } = parseTemplateAgents(yamlText, fallbackInstructions);
  const [agent] = agents;
  if (!agent) throw new Error('Template must have an "agent:" block.');
  const room = asRecord(doc.room);
  return {
    name: agent.name,
    addressing: agent.addressing,
    description: agent.description,
    instructions: agent.instructions,
    repoUrl: agent.repoUrl,
    sources: agent.sources,
    room: room ? { name: optionalString(room.name), kickoff: optionalString(doc.kickoff) } : null,
    provider: agent.provider,
    warnings,
  };
}

function isConsoleParam(spec: unknown): boolean {
  const record = asRecord(spec);
  return record !== null && CONSOLE_PARAM_TYPES.includes(record.type as ConsoleParamType);
}

/** Every `{name}` placeholder written anywhere inside `node`. */
function placeholdersIn(node: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof node === 'string') {
    for (const match of node.matchAll(/\{(\$?\w+)\}/g)) into.add(match[1]);
  } else if (Array.isArray(node)) {
    for (const item of node) placeholdersIn(item, into);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      placeholdersIn(key, into);
      placeholdersIn(value, into);
    }
  }
  return into;
}

/**
 * Build the document the server receives: the room part only, in the shape
 * `POST /rooms/from-yaml` validates.
 *
 * Kept: `room:` (or `group:`, `rooms:`, `links:`), `kickoff:`, `version:`,
 * and the params the room part refers to. Dropped: the agent entries, which
 * the server does not understand; the params of a Console type (`provider`,
 * `location`, `directory`), which only the Console can answer; and any
 * param used only by an agent entry, such as the agent's name or a room it
 * joins, which the Console has already resolved. For the singular `agent:`
 * form, an `agent` param is added so the room's `{agent}` reference resolves
 * on the server.
 *
 * With `keepConsoleParams`, every declared param is kept: the Use page
 * parses this document to build its form and must see them all.
 *
 * Returns null when the document has no room part.
 */
export function serverDocument(
  yamlText: string,
  options: { keepConsoleParams?: boolean } = {}
): string | null {
  const doc = parseYaml(yamlText);
  const room = asRecord(doc.room);
  const isGroup = doc.group !== undefined || Array.isArray(doc.rooms);
  if (!room && !isGroup) return null;

  const usedByRooms = placeholdersIn({
    room: doc.room,
    group: doc.group,
    rooms: doc.rooms,
    links: doc.links,
    kickoff: doc.kickoff,
  });
  const declared = Object.fromEntries(
    Object.entries(asRecord(doc.params) ?? {}).filter(
      ([name, spec]) =>
        options.keepConsoleParams || (!isConsoleParam(spec) && usedByRooms.has(name))
    )
  );
  const params: Record<string, unknown> =
    asRecord(doc.agent) !== null && !Array.isArray(doc.agents)
      ? { agent: { type: 'string', description: 'The agent this room is for' }, ...declared }
      : declared;

  const out: Record<string, unknown> = {};
  if (typeof doc.version === 'number') out.version = doc.version;
  if (Object.keys(params).length > 0) out.params = params;
  if (isGroup) {
    if (doc.group !== undefined) out.group = doc.group;
    out.rooms = doc.rooms ?? [];
    if (doc.links !== undefined) out.links = doc.links;
  } else {
    out.room = room;
  }
  // A top-level kickoff on a group document is a mistake the server reports
  // with a clear message. Passing it through lets the deployer see that message.
  if (doc.kickoff !== undefined) out.kickoff = doc.kickoff;
  return dump(out, { lineWidth: -1 });
}

/**
 * Replace agent names in the server document.
 *
 * `replacements` maps a name as written in the template (`{team}-triager`)
 * to the name the agent has, for the slots whose name differs: the deployer
 * chose an existing agent for that slot instead of creating one, or the
 * name carried a param the Console filled in itself.
 *
 * Every place a room refers to an agent is updated: the `agents:` list, the
 * keys of `aliases:`, and mentions inside `kickoff:` text. In kickoff text a
 * name is replaced only as a whole word, with or without a leading `@`, so
 * renaming `helper` leaves `helper-bot` alone and a mention still names an
 * agent that exists.
 */
export function substituteAgentSlots(
  coreYaml: string,
  replacements: Record<string, string>
): string {
  const doc = parseYaml(coreYaml);
  const rename = (name: unknown) =>
    typeof name === 'string' && Object.hasOwn(replacements, name) ? replacements[name] : name;
  // One pass over the text, longest name first so `{team}-ab` is matched
  // before `{team}-a`, and a name only counts when neither neighbour can
  // continue an agent name: `my-helper` is not `helper`. A dot continues a
  // name only when a name character follows it, so "@helper." at the end of
  // a sentence still matches and `helper._bot` is left alone.
  const names = Object.keys(replacements).sort((a, b) => b.length - a.length);
  const pattern =
    names.length > 0
      ? new RegExp(
          `(?<![A-Za-z0-9_.-])(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`,
          'g'
        )
      : null;
  const inText = (text: unknown) => {
    if (typeof text !== 'string' || pattern === null) return text;
    return text.replace(pattern, (name) => replacements[name]);
  };
  const rooms = [asRecord(doc.room), ...(Array.isArray(doc.rooms) ? doc.rooms.map(asRecord) : [])];
  for (const room of rooms) {
    if (!room) continue;
    if (Array.isArray(room.agents)) room.agents = room.agents.map(rename);
    const aliases = asRecord(room.aliases);
    if (aliases) {
      room.aliases = Object.fromEntries(
        Object.entries(aliases).map(([name, alias]) => [String(rename(name)), alias])
      );
    }
    if (room.kickoff !== undefined) room.kickoff = inText(room.kickoff);
  }
  if (doc.kickoff !== undefined) doc.kickoff = inText(doc.kickoff);
  return dump(doc, { lineWidth: -1 });
}

/**
 * Inline `instructions` into every agent entry that lacks them.
 *
 * Used when saving a bundled template to a server. The bundled Switch expert
 * keeps its instructions in a separate file; a copy stored on the server
 * must be self-contained. YAML comments are lost in the process, field
 * values are kept.
 */
export function composeTemplateDocument(yamlText: string, instructions: string): string {
  const doc = parseYaml(yamlText);
  // The resources themselves, so the brief is written into the document.
  const entries = isVersion2(doc)
    ? resourcesOf(doc, 'agent').map(([, spec]) => spec)
    : rawAgents(doc);
  if (entries.length === 0) throw new Error('Template must have an "agent:" block.');
  for (const agent of entries) {
    if (typeof agent.instructions !== 'string' || agent.instructions.trim().length === 0) {
      agent.instructions = stripFrontMatter(instructions);
    }
  }
  return dump(doc, { lineWidth: -1 });
}

/** A version 2 document's rooms and group, as the Use page shows them. */
export type Version2Rooms = {
  rooms: {
    key: string;
    condition: string | null;
    name: string | null;
    description: string | null;
    agents: string[];
    users: string[];
    bridge: string | null;
    kickoff: string | null;
    placeholders: string[];
  }[];
  groupName: string | null;
  usesCreator: boolean;
};

export function version2Rooms(yamlText: string): Version2Rooms {
  const doc = parseYaml(yamlText);
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  const rooms = resourcesOf(doc, 'room').map(([key, spec]) => ({
    key,
    condition: typeof spec.if === 'string' ? spec.if : null,
    name: optionalString(spec.name),
    description: optionalString(spec.description),
    agents: strings(spec.agents),
    users: strings(spec.users),
    bridge: optionalString(spec.bridge),
    kickoff: optionalString(spec.kickoff),
    placeholders: [...placeholdersIn(spec)],
  }));
  const [group] = resourcesOf(doc, 'group');
  return {
    rooms,
    groupName: group ? optionalString(group[1].name) : null,
    usesCreator: yamlText.includes('{$creator}'),
  };
}
