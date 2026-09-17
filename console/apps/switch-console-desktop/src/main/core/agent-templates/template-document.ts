import { dump, load } from 'js-yaml';
import {
  type AgentTemplateAddressing,
  type AgentTemplateSource,
  extractSources,
  optionalString,
  stripFrontMatter,
} from './agent-template-format';

/**
 * A template document has two parts, created by two different things.
 *
 * - `agent:` or `agents:` describe agents. The Console creates those, because
 *   an agent runs on a machine the Console can reach and the server cannot.
 * - `room:`, or `group:` with `rooms:`, describe rooms. The server creates
 *   those through `POST /rooms/from-yaml`.
 *
 * The two parts refer to each other by agent name. A room's `agents:` list
 * names the agents from the first part with the same text the template uses
 * for them, `{team}-triager` for example, before any `{param}` is filled in.
 * That is why the helpers here work on the raw names: to match a room's
 * entry with the agent it means, they compare the unfilled text.
 *
 * `switch-expert/template.yaml` at the repository root documents every field.
 */
export type TemplateKind = 'agent' | 'room' | 'group';

export type ParsedAgentEntry = {
  /** The name as written in the template, with any `{param}` still unfilled. */
  name: string | null;
  description: string;
  instructions: string;
  repoUrl: string | null;
  sources: AgentTemplateSource[];
  addressing: AgentTemplateAddressing | null;
  /**
   * Which coding agent runs it. Either a provider id (`claude`, `codex`,
   * `opencode`) or a `{param}` whose value is one. Null means the template
   * does not say, and the Use page asks.
   */
  provider: string | null;
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

/** The agent entries as parsed YAML objects, from `agents:` (a list) or `agent:` (a single entry). */
function rawAgents(doc: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(doc.agents)) {
    return doc.agents.map((a) => asRecord(a)).filter((a): a is Record<string, unknown> => !!a);
  }
  const one = asRecord(doc.agent);
  return one ? [one] : [];
}

/**
 * Classify a document by what it creates. `agent` is one agent (with or
 * without a room), `room` is one room and no agents, `group` is anything
 * bigger: several agents, or several rooms.
 */
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
 * Build the document the server receives: the room part only, as a valid
 * room template for `POST /rooms/from-yaml`.
 *
 * Kept: `room:` (or `group:`, `rooms:`, `links:`), `params:`, `kickoff:`,
 * `version:`. Dropped: the agent entries, which the server does not
 * understand, and any `type: provider` param, which only the Console can
 * answer. For the singular `agent:` form, an `agent` param is added so the
 * room's `{agent}` reference resolves on the server.
 *
 * Returns null when the document has no room part.
 */
export function coreDocumentFor(
  yamlText: string,
  options: { keepConsoleParams?: boolean } = {}
): string | null {
  const doc = parseYaml(yamlText);
  const room = asRecord(doc.room);
  const isGroup = doc.group !== undefined || Array.isArray(doc.rooms);
  if (!room && !isGroup) return null;

  // The Use page also parses this document to build its form, and the form
  // must show provider params. Only the copy sent to the server drops them.
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
  // A top-level kickoff on a group document is a mistake the server reports
  // with a clear message. Passing it through lets the person see that message.
  if (doc.kickoff !== undefined) out.kickoff = doc.kickoff;
  return dump(out, { lineWidth: -1 });
}

/**
 * Replace agent names in the server document.
 *
 * `replacements` maps a name as written in the template (`{team}-triager`)
 * to the name the agent has. Two situations need this: the person
 * chose an existing agent for that slot instead of creating one, or the
 * intended name was taken and the agent was created as `name-2`.
 *
 * Every place a room refers to an agent is updated: the `agents:` list, the
 * keys of `aliases:`, and mentions inside `kickoff:` text.
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
 * Remove params the person left empty from the server document, both the
 * declaration under `params:` and every room field set to `{name}`.
 *
 * This exists for `bridge` params. The server treats a missing `bridge:` as
 * "use the default messaging app", so leaving the input empty should produce
 * a room with no `bridge:` field rather than a validation error.
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
 * Inline `instructions` into every agent entry that lacks them.
 *
 * Used when saving a bundled template to a server. The bundled Switch expert
 * keeps its instructions in a separate file; a copy stored on the server
 * must be self-contained. YAML comments are lost in the process, field
 * values are kept.
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
