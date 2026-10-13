import path from 'node:path';
import {
  type AdvancedSettingKind,
  type AdvancedSettings,
  type IRepoAgentsBehavior,
  type LocalRepoAgent,
  type PluginFs,
  type RepoAgentAttributes,
  type RepoAgentDefinition,
  type RepoAgentLaunchDefinition,
  RECOGNISED_SWITCH_TOOL_RULES,
  SWITCH_AGENT_SETTINGS_DIR,
  SWITCH_TOOL_RULES,
} from '@switch-console/core/agents/plugins';

/**
 * Claude Code subagents. Definitions live in `.claude/agents/<name>.md`; once
 * brought into Switch, each gets a credentials file at
 * `.claude/switch-subagents/<name>.settings.json`. A session runs as a subagent
 * via `--agent <name> --settings <credsFile>`, with the file's `SWITCH_*` env
 * also injected as real env vars (the credentials file's `env` block is not
 * reliably propagated to the spawned MCP server otherwise).
 */
/**
 * Forward-slash literals, never `path.join`: these are relative paths handed to
 * a `PluginFs`, which is either the local disk or a remote POSIX host over SFTP,
 * and `path.join` emits backslashes when Switch Console runs on Windows. Same rule
 * as `switch-settings-paths.ts`.
 */
export const CLAUDE_SUBAGENTS = {
  dirRelative: '.claude/switch-subagents',
  settingsSuffix: '.settings.json',
  definitionsDirRelative: '.claude/agents',
} as const;

const SWITCH_ENV_KEYS = ['SWITCH_API_ENDPOINT', 'SWITCH_API_TOKEN', 'SWITCH_AGENT_ID'] as const;

/** Prefix of one tool of the `switch` MCP server. A subagent can only
 * participate in Switch if its tool allowlist grants the server or one of its
 * tools (or omits `tools` entirely, which Claude Code reads as "all tools"). */
const SWITCH_MCP_TOOL_PREFIX = 'mcp__switch__';

/** Rules to strip on read-back, so the form shows only the user's own tools.
 * Wider than what is written, so a definition authored by an older Switch Console
 * does not surface a retired rule as if the user had chosen it. */
const SWITCH_RULES: readonly string[] = RECOGNISED_SWITCH_TOOL_RULES;

const MD_SUFFIX = '.md';

/**
 * The markdown body is the subagent's system prompt, and it is written from
 * the agent's provider-agnostic `instructions` (CHOO-2228) rather than from a
 * Claude-specific field. Every provider renders that one attribute into
 * whatever it reads — for Claude Code, this body; for Codex, its developer
 * instructions — so the key here is the canonical one, not `prompt`.
 */
const BODY_KEY = 'instructions';

/**
 * The advanced settings a subagent definition carries, keyed by their
 * `.claude/agents/<name>.md` frontmatter keys verbatim, in the order they are
 * written. The server defines the fields a person fills them in with; these
 * are what this file writes. hooks / mcpServers / skills are intentionally
 * absent — they are nested/block-list YAML, edit the `.md` directly for those.
 */
const CLAUDE_ADVANCED_SETTINGS: AdvancedSettings = {
  tools: 'list',
  disallowedTools: 'list',
  permissionMode: 'text',
  color: 'text',
  maxTurns: 'number',
  background: 'boolean',
  isolation: 'text',
  effort: 'text',
  memory: 'text',
};

const keysOfKind = (kind: AdvancedSettingKind): Set<string> =>
  new Set(
    Object.entries(CLAUDE_ADVANCED_SETTINGS)
      .filter(([, settingKind]) => settingKind === kind)
      .map(([key]) => key)
  );
const LIST_KEYS = keysOfKind('list');
const NUMBER_KEYS = keysOfKind('number');
const BOOLEAN_KEYS = keysOfKind('boolean');

/** Frontmatter written after the name and description: the model, then the advanced settings. */
const FRONTMATTER_FIELD_KEYS = ['model', ...Object.keys(CLAUDE_ADVANCED_SETTINGS)];

type SubagentFrontmatter = {
  name: string | null;
  description: string | null;
  model: string | null;
  /** Inline `tools: A, B` allowlist; `null` when there is no `tools:` line. */
  tools: string[] | null;
};

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Minimal YAML-frontmatter reader for `.claude/agents/<name>.md`. Returns the
 * top-level `key: value` lines inside the leading `---` fence, keyed by
 * lowercased name; anything more complex (nested structures, block lists) is
 * ignored rather than erroring.
 */
function parseFrontmatterFields(content: string): Record<string, string> {
  const normalised = content.replace(/^﻿/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(normalised);
  if (!match) return {};

  const fields: Record<string, string> = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || rawLine.startsWith(' ') || rawLine.startsWith('\t')) {
      continue;
    }
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = stripQuotes(line.slice(sep + 1));
    if (value.length > 0) fields[key] = value;
  }
  return fields;
}

function parseFrontmatter(content: string): SubagentFrontmatter {
  const fields = parseFrontmatterFields(content);
  return {
    name: fields.name ?? null,
    description: fields.description ?? null,
    model: fields.model ?? null,
    tools: fields.tools !== undefined ? splitList(fields.tools) : null,
  };
}

/**
 * Frontmatter keys the SDK's agent definition has no equivalent for: `color`
 * only tints the agent's name in the terminal, and `isolation` gives a delegated
 * subagent its own worktree, which means nothing for the session's own thread.
 */
const TERMINAL_ONLY_KEYS = new Set(['color', 'isolation']);

/**
 * The SDK agent definition for these attributes — the same agent
 * {@link serializeDefinition} writes to disk, handed over directly instead.
 *
 * Mirrors it rule for rule: the Switch tools are merged into a non-empty
 * `tools` allowlist and never denied, empty values are left out so the
 * session's own defaults apply, and the description stands in as the prompt
 * when there are no instructions.
 */
function launchDefinitionFor(attributes: RepoAgentAttributes): RepoAgentLaunchDefinition {
  const description = toScalar(attributes.description).replace(/\s*\r?\n\s*/g, ' ');
  const definition: RepoAgentLaunchDefinition = {
    description,
    prompt: toScalar(attributes[BODY_KEY]) || description,
  };

  for (const key of FRONTMATTER_FIELD_KEYS) {
    if (TERMINAL_ONLY_KEYS.has(key)) continue;
    const raw = attributes[key];
    if (key === 'tools') {
      const list = toList(raw);
      if (list.length > 0) definition.tools = dedupe([...list, ...SWITCH_TOOL_RULES]);
      continue;
    }
    if (key === 'disallowedTools') {
      const list = toList(raw).filter((t) => !SWITCH_RULES.includes(t));
      if (list.length > 0) definition.disallowedTools = list;
      continue;
    }
    if (BOOLEAN_KEYS.has(key)) {
      if (raw === true || raw === 'true') definition[key] = true;
      continue;
    }
    if (NUMBER_KEYS.has(key)) {
      const n = typeof raw === 'number' ? raw : raw ? Number(raw) : NaN;
      if (Number.isFinite(n) && n > 0) definition[key] = n;
      continue;
    }
    const scalar = toScalar(raw);
    if (scalar.length > 0) definition[key] = scalar;
  }
  return definition;
}

/** The markdown body after the leading frontmatter fence (empty when none). */
function extractBody(content: string): string {
  const normalised = content.replace(/^﻿/, '');
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(normalised);
  return (match ? normalised.slice(match[0].length) : normalised).trim();
}

function toScalar(value: RepoAgentAttributes[string] | undefined): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  return String(value).trim();
}

function toList(value: RepoAgentAttributes[string] | undefined): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0);
  if (typeof value === 'string') return splitList(value);
  return [];
}

/**
 * Serialise a subagent's attributes to a `.claude/agents/<name>.md` file. The
 * Switch connector tools are always merged into a non-empty `tools` allowlist
 * (and never denied) so the subagent stays able to talk to Switch; an empty
 * `tools` is omitted entirely, which inherits all tools. The body defaults to
 * the description when no system prompt is given.
 */
function serializeDefinition(attributes: RepoAgentAttributes): string {
  const name = toScalar(attributes.name);
  const description = toScalar(attributes.description).replace(/\s*\r?\n\s*/g, ' ');
  const lines = ['---', `name: ${name}`, `description: ${description}`];

  for (const key of FRONTMATTER_FIELD_KEYS) {
    const raw = attributes[key];
    if (key === 'tools') {
      const list = toList(raw);
      if (list.length > 0) {
        lines.push(`tools: ${dedupe([...list, ...SWITCH_TOOL_RULES]).join(', ')}`);
      }
      continue;
    }
    if (key === 'disallowedTools') {
      const list = toList(raw).filter((t) => !SWITCH_RULES.includes(t));
      if (list.length > 0) lines.push(`disallowedTools: ${list.join(', ')}`);
      continue;
    }
    if (BOOLEAN_KEYS.has(key)) {
      if (raw === true || raw === 'true') lines.push(`${key}: true`);
      continue;
    }
    if (NUMBER_KEYS.has(key)) {
      const n = typeof raw === 'number' ? raw : raw ? Number(raw) : NaN;
      if (Number.isFinite(n) && n > 0) lines.push(`${key}: ${n}`);
      continue;
    }
    const scalar = toScalar(raw);
    if (scalar.length > 0) lines.push(`${key}: ${scalar}`);
  }

  lines.push('---');
  // An agent with no instructions still needs a body — Claude Code reads it as
  // the system prompt — so the description stands in, as it always has. The
  // read-back below undoes exactly this, so the substitution never comes back
  // as instructions the user never wrote.
  const body = toScalar(attributes[BODY_KEY]) || description;
  return body.length > 0 ? `${lines.join('\n')}\n\n${body}\n` : `${lines.join('\n')}\n`;
}

function isEligible(tools: string[] | null): boolean {
  // No `tools` line → inherits every tool (including the Switch MCP tools).
  if (tools === null) return true;
  return tools.some(
    (tool) => SWITCH_RULES.includes(tool) || tool.startsWith(SWITCH_MCP_TOOL_PREFIX)
  );
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Parse a credentials file's top-level JSON object. Returns `{}` when missing/unparseable. */
function parseSettingsObject(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Legacy per-subagent credentials file under `.claude/switch-subagents/`. */
function settingsRelPath(name: string): string {
  return `${CLAUDE_SUBAGENTS.dirRelative}/${name}${CLAUDE_SUBAGENTS.settingsSuffix}`;
}

/** Provider-neutral per-agent credentials file (the current location). */
function neutralSettingsRelPath(name: string): string {
  return `${SWITCH_AGENT_SETTINGS_DIR}/${name}.json`;
}

/**
 * Read an agent's credentials JSON, preferring the provider-neutral location and
 * falling back to the legacy `.claude/switch-subagents/` file for installs not
 * yet migrated (CHOO-1440).
 */
async function readCredsObject(
  workdirFs: PluginFs,
  name: string
): Promise<Record<string, unknown>> {
  const neutral = await workdirFs.read(neutralSettingsRelPath(name));
  if (neutral !== null) return parseSettingsObject(neutral);
  return parseSettingsObject(await workdirFs.read(settingsRelPath(name)));
}

function definitionRelPath(name: string): string {
  return `${CLAUDE_SUBAGENTS.definitionsDirRelative}/${name}${MD_SUFFIX}`;
}

/** Description/model from a subagent's definition, project scope then user scope. */
async function readDefinitionMeta(
  workdirFs: PluginFs,
  homeFs: PluginFs,
  name: string
): Promise<{ description: string | null; model: string | null }> {
  const project = await workdirFs.read(definitionRelPath(name));
  if (project !== null) {
    const fm = parseFrontmatter(project);
    return { description: fm.description, model: fm.model };
  }
  const home = await homeFs.read(definitionRelPath(name));
  if (home !== null) {
    const fm = parseFrontmatter(home);
    return { description: fm.description, model: fm.model };
  }
  return { description: null, model: null };
}

export const claudeRepoAgentsBehavior: IRepoAgentsBehavior = {
  async discoverLocal(workdirFs, homeFs): Promise<LocalRepoAgent[]> {
    // Names come from either credentials location — the neutral `.switch/agents`
    // dir and the legacy `.claude/switch-subagents` dir — so both migrated and
    // un-migrated installs are discovered (CHOO-1440). Plain agents' creds files
    // live in the neutral dir too (keyed by agent id, no `.claude/agents/<name>.md`
    // definition); a neutral file counts as a subagent only when it has a
    // definition, so those are filtered out here.
    const neutralCandidates = (await workdirFs.list(SWITCH_AGENT_SETTINGS_DIR))
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.slice(0, -'.json'.length))
      .filter((name) => name.length > 0);
    const neutralNames: string[] = [];
    for (const name of neutralCandidates) {
      if (
        (await workdirFs.exists(definitionRelPath(name))) ||
        (await homeFs.exists(definitionRelPath(name)))
      ) {
        neutralNames.push(name);
      }
    }
    const legacyNames = (await workdirFs.list(CLAUDE_SUBAGENTS.dirRelative))
      .filter((entry) => entry.endsWith(CLAUDE_SUBAGENTS.settingsSuffix))
      .map((entry) => entry.slice(0, -CLAUDE_SUBAGENTS.settingsSuffix.length));
    const names = [...new Set([...neutralNames, ...legacyNames])]
      .filter((name) => name.length > 0)
      .sort((a, b) => a.localeCompare(b));

    return Promise.all(
      names.map(async (name) => {
        const settings = await readCredsObject(workdirFs, name);
        const env = (settings.env ?? {}) as Record<string, unknown>;
        const { description, model } = await readDefinitionMeta(workdirFs, homeFs, name);
        return {
          name,
          description,
          model,
          switchAgentId: asNonEmptyString(env.SWITCH_AGENT_ID),
          apiEndpoint: asNonEmptyString(env.SWITCH_API_ENDPOINT),
        };
      })
    );
  },

  async discoverDefinitions(workdirFs): Promise<RepoAgentDefinition[]> {
    const entries = await workdirFs.list(CLAUDE_SUBAGENTS.definitionsDirRelative);
    const files = entries
      .filter((entry) => entry.endsWith(MD_SUFFIX))
      .sort((a, b) => a.localeCompare(b));

    return Promise.all(
      files.map(async (file) => {
        const content =
          (await workdirFs.read(`${CLAUDE_SUBAGENTS.definitionsDirRelative}/${file}`)) ?? '';
        const fm = parseFrontmatter(content);
        const name = fm.name ?? file.slice(0, -MD_SUFFIX.length);
        const registered = await workdirFs.exists(settingsRelPath(name));
        return {
          name,
          description: fm.description,
          model: fm.model,
          eligible: isEligible(fm.tools),
          registered,
        };
      })
    );
  },

  launchArgs(workingDir, agentName): string[] {
    // `path.posix`: workingDir is the agent's dir on whatever host it runs on,
    // which for a remote agent is a POSIX path on the VM. Plain `path.join` on a
    // Windows Switch Console would emit backslash separators into a flag that a
    // Linux shell then has to parse.
    return [
      '--agent',
      agentName,
      '--settings',
      path.posix.join(workingDir, neutralSettingsRelPath(agentName)),
    ];
  },

  async readLaunchEnv(workdirFs, agentName): Promise<Record<string, string>> {
    const settings = await readCredsObject(workdirFs, agentName);
    const env = (settings.env ?? {}) as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const key of SWITCH_ENV_KEYS) {
      const value = asNonEmptyString(env[key]);
      if (value) result[key] = value;
    }
    return result;
  },

  advancedSettings(): AdvancedSettings {
    return CLAUDE_ADVANCED_SETTINGS;
  },

  renderDefinition(attributes: RepoAgentAttributes): string {
    return serializeDefinition(attributes);
  },

  definitionPath(name: string): string {
    return definitionRelPath(name);
  },

  launchDefinition(attributes: RepoAgentAttributes): RepoAgentLaunchDefinition {
    return launchDefinitionFor(attributes);
  },

  async writeDefinition(workdirFs, attributes: RepoAgentAttributes): Promise<void> {
    const name = toScalar(attributes.name);
    await workdirFs.write(definitionRelPath(name), serializeDefinition(attributes));
  },

  async readDefinition(workdirFs, name): Promise<RepoAgentAttributes | null> {
    const content = await workdirFs.read(definitionRelPath(name));
    if (content === null) return null;
    const fields = parseFrontmatterFields(content);

    const description = fields.description ?? '';
    // A body that is just the description is the stand-in `serializeDefinition`
    // writes for an agent with no instructions of its own. Reading it back as
    // instructions would invent a prompt on the round trip, and then pin it.
    const body = extractBody(content);

    const attributes: RepoAgentAttributes = {
      name: fields.name ?? name,
      description,
      [BODY_KEY]: body === description ? '' : body,
    };
    for (const key of FRONTMATTER_FIELD_KEYS) {
      const raw = fields[key.toLowerCase()];
      if (key === 'tools') {
        attributes[key] = splitList(raw).filter((t) => !SWITCH_RULES.includes(t));
      } else if (LIST_KEYS.has(key)) {
        attributes[key] = splitList(raw);
      } else if (BOOLEAN_KEYS.has(key)) {
        attributes[key] = raw === 'true';
      } else if (NUMBER_KEYS.has(key)) {
        attributes[key] = raw ? Number(raw) : null;
      } else {
        attributes[key] = raw ?? '';
      }
    }
    return attributes;
  },

  async removeLocal(workdirFs, name): Promise<void> {
    await workdirFs.delete(definitionRelPath(name));
    await workdirFs.delete(settingsRelPath(name));
  },
};
