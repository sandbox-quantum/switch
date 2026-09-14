import { basename, join } from 'node:path';
import { dump, load } from 'js-yaml';

/**
 * An agent template is a YAML document with an `agent:` block and, optionally,
 * a `room:` and `kickoff:` in the room-template shape. The format is described
 * field by field in `switch-expert/template.yaml` at the repository root.
 */
export type AgentTemplateSource = { url: string; label: string | null };

export type ParsedAgentTemplate = {
  /** Suggested agent name; the person can still change it. */
  name: string | null;
  description: string;
  instructions: string;
  /** Repository the agent works from, cloned next to it before it first runs. */
  repoUrl: string | null;
  /** Pages the agent should read. Shown to the person; the agent's to fetch. */
  sources: AgentTemplateSource[];
  /** The room the agent is dispatched into once it exists, when the template has one. */
  room: { name: string | null; kickoff: string | null } | null;
  warnings: string[];
};

function parseYaml(yamlText: string): Record<string, unknown> {
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

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function extractSources(raw: unknown): AgentTemplateSource[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry === 'string')
      return optionalString(entry) ? [{ url: entry, label: null }] : [];
    const record = asRecord(entry);
    const url = record ? optionalString(record.url) : null;
    if (!url) return [];
    return [{ url, label: record ? optionalString(record.label) : null }];
  });
}

/**
 * A leading YAML front matter block, as a Claude Code agent file carries it.
 * The Console renders the agent's definition file itself, front matter
 * included, so one arriving inside the instructions would be written twice.
 */
export function stripFrontMatter(instructions: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(instructions);
  return match ? instructions.slice(match[0].length).replace(/^\s*\n/, '') : instructions;
}

/**
 * `fallbackInstructions` fills `agent.instructions` when the document leaves
 * it out: the bundled Switch expert keeps its persona in `AGENT.md` rather
 * than inline, so the Console hands it in from there.
 */
export function parseAgentTemplate(
  yamlText: string,
  fallbackInstructions: string | null = null
): ParsedAgentTemplate {
  const doc = parseYaml(yamlText);
  const agent = asRecord(doc.agent);
  if (!agent) {
    throw new Error('Template must have an "agent:" block.');
  }
  const instructions = stripFrontMatter(
    typeof agent.instructions === 'string' && agent.instructions.trim().length > 0
      ? agent.instructions
      : (fallbackInstructions ?? '')
  );
  if (instructions.trim().length === 0) {
    throw new Error('The "agent:" block needs "instructions:" — the agent has nothing to go on.');
  }

  const warnings: string[] = [];
  const room = asRecord(doc.room);
  const kickoff = optionalString(doc.kickoff);
  if (kickoff && !room) {
    warnings.push('`kickoff:` needs a `room:` to be posted into; without one it is ignored.');
  }
  if (typeof agent.kickoff === 'string' || typeof agent.room === 'object') {
    warnings.push('`room:` and `kickoff:` belong at the top level, beside `agent:`.');
  }

  return {
    name: optionalString(agent.name),
    description: typeof agent.description === 'string' ? agent.description.trim() : '',
    instructions,
    repoUrl: optionalString(agent.repo),
    sources: extractSources(agent.sources),
    room: room ? { name: optionalString(room.name), kickoff } : null,
    warnings,
  };
}

/**
 * The room half of an agent template as a room template of its own, ready for
 * `POST /rooms/from-yaml`. `{agent}` becomes a declared param the server fills
 * from the inputs, so the room block can name the agent the same way it names
 * `{$creator}`. Null when the template has no room.
 */
export function agentTemplateRoomDocument(yamlText: string): string | null {
  const doc = parseYaml(yamlText);
  const room = asRecord(doc.room);
  if (!room) return null;
  const declared = asRecord(doc.params) ?? {};
  const params = {
    agent: { type: 'string', description: 'The agent this room is for' },
    ...declared,
  };
  const out: Record<string, unknown> = { params, room };
  if (typeof doc.kickoff === 'string') out.kickoff = doc.kickoff;
  return dump(out, { lineWidth: -1 });
}

/** The directory a clone of `repoUrl` lands in: the repository's name, inside `dir`. */
export function cloneTargetFor(dir: string, repoUrl: string): string {
  const name = basename(repoUrl.replace(/\/+$/, '')).replace(/\.git$/, '');
  return join(dir, name || 'repo');
}
