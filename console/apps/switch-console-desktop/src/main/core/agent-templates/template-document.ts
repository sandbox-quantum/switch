import { dump, load } from 'js-yaml';
import {
  type AgentTemplateAddressing,
  type AgentTemplateSource,
  extractSources,
  optionalString,
  stripFrontMatter,
} from './agent-template-format';

/**
 * One template document, both halves. The Console creates what `agents:` (or
 * the singular `agent:`) describes; the server creates what `room:` or
 * `group:` + `rooms:` describes. The two are joined by name: a room lists the
 * agents the Console is about to make, spelled the way the template spells
 * them, `{param}`s included. The format is described field by field in
 * `switch-expert/template.yaml` at the repository root.
 */
export type TemplateKind = 'agent' | 'room' | 'group';

export type ParsedAgentEntry = {
  /** The name as the template spells it, placeholders and all. */
  name: string | null;
  description: string;
  instructions: string;
  repoUrl: string | null;
  sources: AgentTemplateSource[];
  addressing: AgentTemplateAddressing | null;
  /** A provider id or a `{param}` naming one; null leaves the choice to the page. */
  provider: string | null;
};

export type TemplateAgents = {
  agents: ParsedAgentEntry[];
  /** Written as a lone `agent:` block, whose room names it `{agent}`. */
  singular: boolean;
  warnings: string[];
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

/** The raw agent entries of a document: `agents:` list, or `agent:` alone. */
function rawAgents(doc: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(doc.agents)) {
    return doc.agents.map((a) => asRecord(a)).filter((a): a is Record<string, unknown> => !!a);
  }
  const one = asRecord(doc.agent);
  return one ? [one] : [];
}

/** Which page a document opens on, decided by what it creates. */
export function templateKind(yamlText: string): TemplateKind {
  return kindOf(parseYaml(yamlText));
}

export function kindOf(doc: Record<string, unknown>): TemplateKind {
  const agents = rawAgents(doc);
  if (doc.group !== undefined || Array.isArray(doc.rooms)) return 'group';
  if (agents.length > 1) return 'group';
  if (agents.length === 1) return 'agent';
  return 'room';
}

/**
 * `fallbackInstructions` fills a lone agent's `instructions:` when the
 * document leaves it out: the bundled Switch expert keeps its persona in
 * `AGENT.md` rather than inline, so the Console hands it in from there.
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
      description: typeof agent.description === 'string' ? agent.description.trim() : '',
      instructions,
      repoUrl: optionalString(agent.repo),
      sources: extractSources(agent.sources),
      addressing: ADDRESSING_VALUES.has(addressing ?? '')
        ? (addressing as AgentTemplateAddressing)
        : null,
      provider: optionalString(agent.provider),
    };
  });
  return { agents, singular: !Array.isArray(doc.agents) && agents.length === 1, warnings };
}

function isProviderParam(spec: unknown): boolean {
  const record = asRecord(spec);
  return record !== null && record.type === 'provider';
}

/**
 * The half of a document the server provisions, as a template of its own,
 * ready for `POST /rooms/from-yaml`: `room:` or `group:` + `rooms:` + `links:`,
 * the params the server can resolve, and a single room's `kickoff:`. Agents
 * and `type: provider` params are the Console's and are left out. A lone
 * `agent:` gets `{agent}` declared as a param, so its room can name it the
 * way it names `{$creator}`. Null when there is nothing for the server.
 */
export function coreDocumentFor(
  yamlText: string,
  options: { keepConsoleParams?: boolean } = {}
): string | null {
  const doc = parseYaml(yamlText);
  const room = asRecord(doc.room);
  const isGroup = doc.group !== undefined || Array.isArray(doc.rooms);
  if (!room && !isGroup) return null;

  // The form reads the params off this document too, and it has to see the
  // Console's own ones; only what goes to the server leaves them out.
  const declared = Object.fromEntries(
    Object.entries(asRecord(doc.params) ?? {}).filter(
      ([, spec]) => options.keepConsoleParams || !isProviderParam(spec)
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
  // Kept even on a group document, where the server refuses it with a
  // message saying where it goes; dropping it here would hide that.
  if (doc.kickoff !== undefined) out.kickoff = doc.kickoff;
  return dump(out, { lineWidth: -1 });
}

/**
 * Rename agents in the server half: every room's `agents:` entry and
 * `aliases:` key that reads exactly `from` becomes `to`, and a kickoff that
 * mentions `from` mentions `to`. Used when a slot the template meant to
 * create is filled by an existing agent instead, or the name it wanted was
 * taken and the agent was made under another.
 */
export function substituteAgentSlots(
  coreYaml: string,
  replacements: Record<string, string>
): string {
  const doc = parseYaml(coreYaml);
  const rename = (name: unknown) =>
    typeof name === 'string' && Object.hasOwn(replacements, name) ? replacements[name] : name;
  const inText = (text: unknown) => {
    if (typeof text !== 'string') return text;
    let out = text;
    for (const [from, to] of Object.entries(replacements)) out = out.split(from).join(to);
    return out;
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
 * Take declared params the person left unset out of the server half: the
 * declaration itself, and every room field that is exactly `{name}`. A
 * `bridge` input with no default is the case: empty means the server's
 * default messaging app, which is what a room with no `bridge:` gets.
 */
export function dropUnsetParams(coreYaml: string, names: string[]): string {
  if (names.length === 0) return coreYaml;
  const doc = parseYaml(coreYaml);
  const params = asRecord(doc.params);
  if (params) {
    for (const name of names) delete params[name];
    if (Object.keys(params).length === 0) delete doc.params;
  }
  const placeholders = new Set(names.map((n) => `{${n}}`));
  const rooms = [asRecord(doc.room), ...(Array.isArray(doc.rooms) ? doc.rooms.map(asRecord) : [])];
  for (const room of rooms) {
    if (!room) continue;
    for (const [key, value] of Object.entries(room)) {
      if (typeof value === 'string' && placeholders.has(value)) delete room[key];
    }
  }
  return dump(doc, { lineWidth: -1 });
}

/**
 * The document with every agent's `instructions:` filled in, for a template
 * whose persona lives beside it rather than inline (the bundled Switch
 * expert). A copy stored on a server has to carry everything, so this is
 * what gets sent. Comments do not survive the round trip; the fields do.
 */
export function composeTemplateDocument(yamlText: string, instructions: string): string {
  const doc = parseYaml(yamlText);
  const entries = rawAgents(doc);
  if (entries.length === 0) throw new Error('Template must have an "agent:" block.');
  for (const agent of entries) {
    if (typeof agent.instructions !== 'string' || agent.instructions.trim().length === 0) {
      agent.instructions = stripFrontMatter(instructions);
    }
  }
  return dump(doc, { lineWidth: -1 });
}
