import { basename, join } from 'node:path';
import { load } from 'js-yaml';
import { composeTemplateDocument, coreDocumentFor } from './template-document';

/**
 * An agent template is a YAML document with an `agent:` block and, optionally,
 * a `room:` and `kickoff:` in the room-template shape. The format is described
 * field by field in `switch-expert/template.yaml` at the repository root.
 */
export type AgentTemplateSource = { url: string; label: string | null };

/** Who may address the agent, as a template declares it. Null means the
 * Console's default (only its owner). */
export type AgentTemplateAddressing = 'owner' | 'owner-agents' | 'anyone';

export type ParsedAgentTemplate = {
  /** Suggested agent name; the person can still change it. */
  name: string | null;
  addressing: AgentTemplateAddressing | null;
  description: string;
  instructions: string;
  /** Repository the agent works from, cloned next to it before it first runs. */
  repoUrl: string | null;
  /** Pages the agent should read. Shown to the person; the agent's to fetch. */
  sources: AgentTemplateSource[];
  /** The room the agent is dispatched into once it exists, when the template has one. */
  room: { name: string | null; kickoff: string | null } | null;
  /** A provider id or a `{param}` naming one; null leaves the choice to the person. */
  provider: string | null;
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

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const ADDRESSING_VALUES: ReadonlySet<string> = new Set(['owner', 'owner-agents', 'anyone']);

export function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function extractSources(raw: unknown): AgentTemplateSource[] {
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

  const addressing = optionalString(agent.addressing);
  if (addressing !== null && !ADDRESSING_VALUES.has(addressing)) {
    warnings.push(
      `\`addressing: ${addressing}\` is not one of owner, owner-agents, anyone; the agent will answer only its owner.`
    );
  }

  return {
    name: optionalString(agent.name),
    addressing: ADDRESSING_VALUES.has(addressing ?? '')
      ? (addressing as AgentTemplateAddressing)
      : null,
    description: typeof agent.description === 'string' ? agent.description.trim() : '',
    instructions,
    repoUrl: optionalString(agent.repo),
    sources: extractSources(agent.sources),
    room: room ? { name: optionalString(room.name), kickoff } : null,
    provider: optionalString(agent.provider),
    warnings,
  };
}

/**
 * The room half of an agent template as a room template of its own, ready for
 * `POST /rooms/from-yaml`. See `coreDocumentFor`; kept under its old name for
 * the single-agent callers.
 */
export function agentTemplateRoomDocument(yamlText: string): string | null {
  return coreDocumentFor(yamlText);
}

/** See `composeTemplateDocument`; kept under its old name for the single-agent callers. */
export function composeAgentTemplateDocument(yamlText: string, instructions: string): string {
  return composeTemplateDocument(yamlText, instructions);
}

/** The directory a clone of `repoUrl` lands in: the repository's name, inside `dir`. */
export function cloneTargetFor(dir: string, repoUrl: string): string {
  const name = basename(repoUrl.replace(/\/+$/, '')).replace(/\.git$/, '');
  return join(dir, name || 'repo');
}

/**
 * `base`, or `base-2`, `base-3`… when `base` already holds an agent (a
 * `.switch/` directory). A leftover from an earlier install carries that
 * agent's credentials, and the add-agent pre-flight refuses to overwrite
 * them; better to land next door than to fail after the click.
 */
export async function firstFreeDirectory(
  base: string,
  isTaken: (dir: string) => Promise<boolean>
): Promise<string> {
  let candidate = base;
  for (let i = 2; await isTaken(candidate); i++) candidate = `${base}-${i}`;
  return candidate;
}
