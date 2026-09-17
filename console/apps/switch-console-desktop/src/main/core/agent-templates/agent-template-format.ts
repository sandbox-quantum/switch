import { basename, join } from 'node:path';
import { load } from 'js-yaml';
import { composeTemplateDocument, coreDocumentFor } from './template-document';

/**
 * An agent template is a YAML document with an `agent:` block and, optionally,
 * a `room:` and `kickoff:` in the room-template shape. The format is described
 * field by field in `switch-expert/template.yaml` at the repository root.
 */
export type AgentTemplateSource = { url: string; label: string | null };

/** Who may address the agent, as declared in the template. Null when the
 * template has no `addressing` field; the Console's default applies (only its owner). */
export type AgentTemplateAddressing = 'owner' | 'owner-agents' | 'anyone';

export type ParsedAgentTemplate = {
  /** The agent name from the template's `name` field. The deployer can change it before creating. */
  name: string | null;
  addressing: AgentTemplateAddressing | null;
  description: string;
  instructions: string;
  /** Repository the agent works from. Cloned into its working directory before it first runs. */
  repoUrl: string | null;
  /** Pages the agent should read. Shown to the deployer; the agent fetches them itself. */
  sources: AgentTemplateSource[];
  /** The room the agent is put in once it exists, when the template declares one. */
  room: { name: string | null; kickoff: string | null } | null;
  /** A provider id (`claude`, `codex`, `opencode`) or a `{param}` whose value is one. Null when the template has no `provider` field. */
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
 * Remove a leading YAML front matter block from instructions. Claude Code
 * agent files start with one, and the Console writes its own when it
 * renders the agent's definition file, so one inside the instructions
 * would be written twice.
 */
export function stripFrontMatter(instructions: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(instructions);
  return match ? instructions.slice(match[0].length).replace(/^\s*\n/, '') : instructions;
}

/**
 * Parse a single-agent template.
 *
 * `fallbackInstructions` is used when the document has no `instructions:`.
 * The bundled Switch expert keeps its instructions in `AGENT.md` next to
 * the template, and the Console passes that file's content here.
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

/** Same as `coreDocumentFor`, for callers that only handle a single `agent:` document. */
export function agentTemplateRoomDocument(yamlText: string): string | null {
  return coreDocumentFor(yamlText);
}

/** Same as `composeTemplateDocument`, for callers that only handle a single `agent:` document. */
export function composeAgentTemplateDocument(yamlText: string, instructions: string): string {
  return composeTemplateDocument(yamlText, instructions);
}

/** The directory a clone of `repoUrl` goes in: a folder named after the repository, inside `dir`. */
export function cloneTargetFor(dir: string, repoUrl: string): string {
  const name = basename(repoUrl.replace(/\/+$/, '')).replace(/\.git$/, '');
  return join(dir, name || 'repo');
}

/**
 * `base`, or the first of `base-2`, `base-3`, … that does not already hold
 * an agent (a `.switch/` directory). A directory left behind by a removed
 * agent still holds that agent's credentials, and creating an agent refuses
 * to overwrite them, so the suggestion moves to a free directory instead of
 * failing at creation time.
 */
export async function firstFreeDirectory(
  base: string,
  isTaken: (dir: string) => Promise<boolean>
): Promise<string> {
  let candidate = base;
  for (let i = 2; await isTaken(candidate); i++) candidate = `${base}-${i}`;
  return candidate;
}
