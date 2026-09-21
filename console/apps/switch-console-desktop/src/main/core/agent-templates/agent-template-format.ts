import { basename, join } from 'node:path';

/**
 * An agent template is a YAML document with an `agent:` block and, optionally,
 * a `room:` and `kickoff:` in the room-template shape. The format is described
 * field by field in `switch-expert/template.yaml` at the repository root.
 */
export type AgentTemplateSource = { url: string; label: string | null };

/** Who may address the agent: only its owner, its owner and their agents, or anyone in its rooms. */
export type AgentTemplateAddressing = 'owner' | 'owner-agents' | 'anyone';

export type ParsedAgentTemplate = {
  /** The agent name from the template's `name` field. The deployer can change it before creating. */
  name: string | null;
  /** Null when the template has no `addressing` field; the Console's default applies (only its owner). */
  addressing: AgentTemplateAddressing | null;
  description: string;
  instructions: string;
  /** Repository the agent works from. The Console offers to clone it into the
   * agent's directory; when that is off or fails, the agent clones it itself. */
  repoUrl: string | null;
  /** Pages the agent should read. Shown to the deployer; the agent fetches them itself. */
  sources: AgentTemplateSource[];
  /** The room the agent is put in once it exists, when the template declares one. */
  room: { name: string | null; kickoff: string | null } | null;
  /** A provider id (`claude`, `codex`, `opencode`) or a `{param}` whose value is one. Null when the template has no `provider` field. */
  provider: string | null;
  warnings: string[];
};

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

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

/** A folder named after the repository, inside `dir`. */
export function cloneDirectory(dir: string, repoUrl: string): string {
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
