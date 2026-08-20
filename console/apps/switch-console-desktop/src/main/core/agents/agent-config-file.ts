import { createHash } from 'node:crypto';
import type { PluginFs, RepoAgentAttributes } from '@switch-console/core/agents/plugins';
import { agentConfigRelativePath } from './switch-settings-paths';

/**
 * An agent's committed, secret-free config file (CHOO-2228).
 *
 * The file that already exists per agent — `.switch/agents/<slug>.json` —
 * carries the agent's API token and is gitignored for that reason, so it can
 * never be the home for settings meant to travel. This is its counterpart: no
 * credentials, checked in alongside the code the agent works on, so a second
 * machine opening the same working directory sees the same agent.
 *
 * **Sparse by construction.** Only values someone actually set are written. A
 * key that is absent means "not specified", which is not the same as an empty
 * value — it leaves the provider's own default in force. Writing defaults out
 * explicitly would freeze today's defaults into every user's repository and
 * make a later change to them invisible.
 *
 * This is the source of truth for an agent's configuration. Each provider's
 * own file — a Claude Code subagent definition, a Codex profile, an OpenCode
 * config — is generated from it, so those are outputs rather than places to
 * edit. The one exception is deliberate: a hand-edited Claude Code definition
 * is read back in rather than overwritten, which `rendered` below is what
 * makes decidable.
 */
export type AgentConfigFile = {
  /** The agent's provider-agnostic system prompt. Absent when none is set. */
  instructions?: string;
  /**
   * The agent's remaining settings, keyed by the field keys the provider
   * declares. Provider-specific by nature — Codex has a reasoning effort,
   * Claude Code has a tool list — so this is a map rather than a modelled
   * shape, and a key the provider no longer declares is carried rather than
   * dropped.
   */
  settings?: RepoAgentAttributes;
  /**
   * Fingerprint of the provider artifact as this app last generated it, keyed
   * by the artifact's path relative to the working directory.
   *
   * This is what makes the round trip decidable. Comparing an artifact to what
   * the config would generate right now cannot distinguish "the config
   * changed" from "someone edited the file"; comparing it to what was last
   * written can. A match means the file is untouched and the config should be
   * written out; a mismatch means it was hand-edited and those edits should be
   * read back in.
   */
  rendered?: Record<string, string>;
};

/**
 * Parse an agent config file's text.
 *
 * A file that is unreadable JSON, or holds something other than an object, is
 * reported as such rather than silently treated as empty: the alternative is a
 * read-modify-write that quietly discards whatever the user had, and an agent
 * launching with no instructions when it should have had some.
 */
export function parseAgentConfigFile(raw: string): AgentConfigFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Agent config file is not valid JSON`, { cause });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Agent config file must contain a JSON object`);
  }

  const record = parsed as Record<string, unknown>;
  const config: AgentConfigFile = {};
  if (typeof record.instructions === 'string') config.instructions = record.instructions;
  if (isPlainObject(record.settings)) config.settings = record.settings as RepoAgentAttributes;
  if (isPlainObject(record.rendered)) {
    const rendered: Record<string, string> = {};
    for (const [path, digest] of Object.entries(record.rendered)) {
      if (typeof digest === 'string') rendered[path] = digest;
    }
    config.rendered = rendered;
  }
  return config;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Serialise a config file, dropping anything unset.
 *
 * `unknownKeys` are keys read from an existing file that this version does not
 * model; they are written back untouched so a newer Switch Console's settings
 * survive an older one editing the same repository.
 */
export function serialiseAgentConfigFile(
  config: AgentConfigFile,
  unknownKeys: Record<string, unknown> = {}
): string {
  const out: Record<string, unknown> = { ...unknownKeys };
  delete out.instructions;
  delete out.settings;
  delete out.rendered;

  // Blank is how the owner says "none", and none is the absent state — the
  // value itself is written exactly as given, never trimmed, because trimming
  // would quietly reshape a system prompt whose whitespace is deliberate.
  if (config.instructions !== undefined && config.instructions !== '') {
    out.instructions = config.instructions;
  }

  const settings = pruneUnsetSettings(config.settings ?? {});
  if (Object.keys(settings).length > 0) out.settings = settings;

  if (config.rendered && Object.keys(config.rendered).length > 0) out.rendered = config.rendered;

  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * Drop settings nobody chose, so the file records decisions rather than a
 * snapshot of today's defaults. Empty strings, empty lists and nulls all mean
 * "not set"; `false` and `0` are real choices and are kept.
 */
function pruneUnsetSettings(settings: RepoAgentAttributes): RepoAgentAttributes {
  const out: RepoAgentAttributes = {};
  for (const [key, value] of Object.entries(settings)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Read an agent's config file, or null when it has none.
 *
 * A missing file is the ordinary state for an agent nobody has configured, so
 * it reads as null. Anything else — a malformed file, an unreadable one —
 * throws, because continuing would mean launching the agent without
 * instructions its owner believes it has.
 */
export async function readAgentConfigFile(
  fs: PluginFs,
  slug: string
): Promise<AgentConfigFile | null> {
  const raw = await fs.read(agentConfigRelativePath(slug));
  if (raw === null) return null;
  return parseAgentConfigFile(raw);
}

/**
 * Write an agent's config file, preserving keys this version does not model.
 *
 * Read-modify-write rather than clobber: the file is checked in and may have
 * been written by a different version of the app.
 */
export async function writeAgentConfigFile(
  fs: PluginFs,
  slug: string,
  config: AgentConfigFile
): Promise<void> {
  const relativePath = agentConfigRelativePath(slug);
  const existingRaw = await fs.read(relativePath);

  let unknownKeys: Record<string, unknown> = {};
  if (existingRaw !== null) {
    const parsed: unknown = JSON.parse(existingRaw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      unknownKeys = parsed as Record<string, unknown>;
    }
  }

  await fs.write(relativePath, serialiseAgentConfigFile(config, unknownKeys));
}

/**
 * Fingerprint of a generated artifact's exact bytes.
 *
 * Only ever compared against another fingerprint from this same function, so
 * the algorithm is an implementation detail — but it is written into a
 * committed file, so changing it would make every artifact look hand-edited
 * once. Truncated because a collision here means "we failed to notice an edit",
 * not a security boundary.
 */
export function fingerprintArtifact(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 32);
}

/**
 * What to do about one provider artifact, given the config, the artifact as it
 * currently sits on disk, and the fingerprint of the last generated version.
 *
 * - `write` — the artifact is missing, or it is exactly what was last
 *   generated. Nothing local was lost, so generate from the config.
 * - `adopt` — the artifact differs from what was last generated. Somebody
 *   edited it by hand; read those edits back into the config rather than
 *   overwriting them.
 * - `in-sync` — the artifact already is what the config generates.
 *
 * The distinction `write` vs `adopt` rests entirely on the recorded
 * fingerprint. With no fingerprint — an agent that predates this, or one
 * someone else set up — an existing artifact is treated as hand-authored,
 * because assuming otherwise silently discards a prompt this app never wrote.
 */
export type ArtifactSyncAction = 'write' | 'adopt' | 'in-sync';

export function decideArtifactSync(params: {
  /** The artifact as it is on disk, or null when there is none. */
  current: string | null;
  /** What generating from the current config produces right now. */
  generated: string;
  /** Fingerprint recorded when this app last generated it, if ever. */
  lastRendered: string | undefined;
}): ArtifactSyncAction {
  const { current, generated, lastRendered } = params;
  if (current === null) return 'write';
  if (current === generated) return 'in-sync';
  if (lastRendered === undefined) return 'adopt';
  return fingerprintArtifact(current) === lastRendered ? 'write' : 'adopt';
}
