import path from 'node:path';
import {
  type IRepoAgentsBehavior,
  type LocalRepoAgent,
  type PluginFs,
  type RepoAgentAttributes,
  type RepoAgentDefinition,
  type RepoAgentField,
  SWITCH_AGENT_SETTINGS_DIR,
  SWITCH_CONNECTOR_TOOL_RULES,
} from '@switchdash/core/agents/plugins';

/**
 * Claude Code subagents. Definitions live in `.claude/agents/<name>.md`; once
 * brought into Switch, each gets a credentials file at
 * `.claude/switch-subagents/<name>.settings.json`. A session runs as a subagent
 * via `--agent <name> --settings <credsFile>`, with the file's `SWITCH_*` env
 * also injected as real env vars (the credentials file's `env` block is not
 * reliably propagated to the spawned MCP server otherwise).
 */
export const CLAUDE_SUBAGENTS = {
  dirRelative: path.join('.claude', 'switch-subagents'),
  settingsSuffix: '.settings.json',
  definitionsDirRelative: path.join('.claude', 'agents'),
} as const;

const SWITCH_ENV_KEYS = ['SWITCH_API_ENDPOINT', 'SWITCH_API_TOKEN', 'SWITCH_AGENT_ID'] as const;

/** Prefix of the Switch connector's MCP tools. A subagent can only participate
 * in Switch if its tool allowlist grants it (or omits `tools` entirely, which
 * Claude Code reads as "all tools"). */
const SWITCH_MCP_TOOL_PREFIX = 'mcp__plugin_switch-connector_switch';

/** Non-literal view of the connector rules for `.includes` over arbitrary strings. */
const SWITCH_RULES: readonly string[] = SWITCH_CONNECTOR_TOOL_RULES;

const MD_SUFFIX = '.md';

/** The `prompt` attribute is the markdown body (system prompt), not frontmatter. */
const BODY_KEY = 'prompt';
const LIST_KEYS = new Set(['tools', 'disallowedTools']);
const NUMBER_KEYS = new Set(['maxTurns']);
const BOOLEAN_KEYS = new Set(['background']);

/** Attribute fields Claude Code subagents support, in form display order. The
 * field keys match the `.claude/agents/<name>.md` frontmatter keys verbatim
 * (`prompt` being the body). hooks / mcpServers / skills are intentionally
 * omitted — they are nested/block-list YAML, edit the `.md` directly for those. */
const CLAUDE_SUBAGENT_FIELDS: RepoAgentField[] = [
  {
    key: 'name',
    label: 'Name',
    type: 'text',
    required: true,
    immutableOnEdit: true,
    placeholder: 'code-reviewer',
    help: "The subagent's identity (lowercase letters, digits, . _ -). Can't be changed later.",
  },
  {
    key: 'description',
    label: 'Description',
    type: 'text',
    required: true,
    placeholder: 'Reviews diffs for correctness and style.',
    help: 'When the parent should delegate to this subagent.',
  },
  {
    key: 'prompt',
    label: 'System prompt',
    type: 'textarea',
    placeholder: 'Defaults to the description. Add instructions to specialise the subagent.',
    help: "The subagent's system prompt (the markdown body).",
  },
  {
    key: 'model',
    label: 'Model',
    type: 'text',
    placeholder: 'inherit',
    help: 'inherit, an alias (sonnet, opus, haiku, fable), or a full model id. Empty = inherit.',
  },
  {
    key: 'tools',
    label: 'Tools',
    type: 'list',
    placeholder: 'Read, Grep, Bash',
    help: 'Comma-separated allowlist. Empty inherits all tools. The Switch tools are always kept.',
  },
  {
    key: 'disallowedTools',
    label: 'Disallowed tools',
    type: 'list',
    placeholder: 'Write, Edit',
    help: 'Comma-separated tools to deny from the inherited/allowed set.',
  },
  {
    key: 'permissionMode',
    label: 'Permission mode',
    type: 'select',
    options: [
      { value: '', label: 'Default (inherit)' },
      { value: 'default', label: 'default' },
      { value: 'acceptEdits', label: 'acceptEdits' },
      { value: 'auto', label: 'auto' },
      { value: 'dontAsk', label: 'dontAsk' },
      { value: 'bypassPermissions', label: 'bypassPermissions' },
      { value: 'plan', label: 'plan' },
    ],
  },
  {
    key: 'color',
    label: 'Color',
    type: 'select',
    options: [
      { value: '', label: 'None' },
      { value: 'red', label: 'red' },
      { value: 'blue', label: 'blue' },
      { value: 'green', label: 'green' },
      { value: 'yellow', label: 'yellow' },
      { value: 'purple', label: 'purple' },
      { value: 'orange', label: 'orange' },
      { value: 'pink', label: 'pink' },
      { value: 'cyan', label: 'cyan' },
    ],
  },
  { key: 'maxTurns', label: 'Max turns', type: 'number', placeholder: 'unlimited' },
  {
    key: 'background',
    label: 'Always run in background',
    type: 'boolean',
    help: 'Run this subagent as a background task.',
  },
  {
    key: 'isolation',
    label: 'Isolation',
    type: 'select',
    options: [
      { value: '', label: 'None' },
      { value: 'worktree', label: 'worktree (isolated git copy)' },
    ],
  },
  {
    key: 'effort',
    label: 'Effort',
    type: 'select',
    options: [
      { value: '', label: 'Inherit' },
      { value: 'low', label: 'low' },
      { value: 'medium', label: 'medium' },
      { value: 'high', label: 'high' },
      { value: 'xhigh', label: 'xhigh' },
      { value: 'max', label: 'max' },
    ],
  },
  {
    key: 'memory',
    label: 'Persistent memory',
    type: 'select',
    options: [
      { value: '', label: 'Off' },
      { value: 'user', label: 'user' },
      { value: 'project', label: 'project' },
      { value: 'local', label: 'local' },
    ],
  },
];

const FRONTMATTER_FIELD_KEYS = CLAUDE_SUBAGENT_FIELDS.map((f) => f.key).filter(
  (key) => key !== 'name' && key !== 'description' && key !== BODY_KEY
);

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
        lines.push(`tools: ${dedupe([...list, ...SWITCH_CONNECTOR_TOOL_RULES]).join(', ')}`);
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
  const body = toScalar(attributes[BODY_KEY]) || description;
  return body.length > 0 ? `${lines.join('\n')}\n\n${body}\n` : `${lines.join('\n')}\n`;
}

function isEligible(tools: string[] | null): boolean {
  // No `tools` line → inherits every tool (including the Switch MCP tools).
  if (tools === null) return true;
  return tools.some((tool) => tool.startsWith(SWITCH_MCP_TOOL_PREFIX));
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
  return path.join(CLAUDE_SUBAGENTS.dirRelative, `${name}${CLAUDE_SUBAGENTS.settingsSuffix}`);
}

/** Provider-neutral per-agent credentials file (the current location). */
function neutralSettingsRelPath(name: string): string {
  return path.join(SWITCH_AGENT_SETTINGS_DIR, `${name}.json`);
}

/**
 * Read an agent's credentials JSON, preferring the provider-neutral location and
 * falling back to the legacy `.claude/switch-subagents/` file for installs not
 * yet migrated (CHOO-1440).
 */
async function readCredsObject(
  workspaceFs: PluginFs,
  name: string
): Promise<Record<string, unknown>> {
  const neutral = await workspaceFs.read(neutralSettingsRelPath(name));
  if (neutral !== null) return parseSettingsObject(neutral);
  return parseSettingsObject(await workspaceFs.read(settingsRelPath(name)));
}

function definitionRelPath(name: string): string {
  return path.join(CLAUDE_SUBAGENTS.definitionsDirRelative, `${name}${MD_SUFFIX}`);
}

/** Description/model from a subagent's definition, project scope then user scope. */
async function readDefinitionMeta(
  workspaceFs: PluginFs,
  homeFs: PluginFs,
  name: string
): Promise<{ description: string | null; model: string | null }> {
  const project = await workspaceFs.read(definitionRelPath(name));
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
  async discoverLocal(workspaceFs, homeFs): Promise<LocalRepoAgent[]> {
    // Names come from either credentials location — the neutral `.switch/agents`
    // dir and the legacy `.claude/switch-subagents` dir — so both migrated and
    // un-migrated installs are discovered (CHOO-1440). Plain agents' creds files
    // live in the neutral dir too (keyed by agent id, no `.claude/agents/<name>.md`
    // definition); a neutral file counts as a subagent only when it has a
    // definition, so those are filtered out here.
    const neutralCandidates = (await workspaceFs.list(SWITCH_AGENT_SETTINGS_DIR))
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.slice(0, -'.json'.length))
      .filter((name) => name.length > 0);
    const neutralNames: string[] = [];
    for (const name of neutralCandidates) {
      if (
        (await workspaceFs.exists(definitionRelPath(name))) ||
        (await homeFs.exists(definitionRelPath(name)))
      ) {
        neutralNames.push(name);
      }
    }
    const legacyNames = (await workspaceFs.list(CLAUDE_SUBAGENTS.dirRelative))
      .filter((entry) => entry.endsWith(CLAUDE_SUBAGENTS.settingsSuffix))
      .map((entry) => entry.slice(0, -CLAUDE_SUBAGENTS.settingsSuffix.length));
    const names = [...new Set([...neutralNames, ...legacyNames])]
      .filter((name) => name.length > 0)
      .sort((a, b) => a.localeCompare(b));

    return Promise.all(
      names.map(async (name) => {
        const settings = await readCredsObject(workspaceFs, name);
        const env = (settings.env ?? {}) as Record<string, unknown>;
        const { description, model } = await readDefinitionMeta(workspaceFs, homeFs, name);
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

  async discoverDefinitions(workspaceFs): Promise<RepoAgentDefinition[]> {
    const entries = await workspaceFs.list(CLAUDE_SUBAGENTS.definitionsDirRelative);
    const files = entries
      .filter((entry) => entry.endsWith(MD_SUFFIX))
      .sort((a, b) => a.localeCompare(b));

    return Promise.all(
      files.map(async (file) => {
        const content =
          (await workspaceFs.read(path.join(CLAUDE_SUBAGENTS.definitionsDirRelative, file))) ?? '';
        const fm = parseFrontmatter(content);
        const name = fm.name ?? file.slice(0, -MD_SUFFIX.length);
        const registered = await workspaceFs.exists(settingsRelPath(name));
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
    return [
      '--agent',
      agentName,
      '--settings',
      path.join(workingDir, neutralSettingsRelPath(agentName)),
    ];
  },

  async readLaunchEnv(workspaceFs, agentName): Promise<Record<string, string>> {
    const settings = await readCredsObject(workspaceFs, agentName);
    const env = (settings.env ?? {}) as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const key of SWITCH_ENV_KEYS) {
      const value = asNonEmptyString(env[key]);
      if (value) result[key] = value;
    }
    return result;
  },

  attributeFields(): RepoAgentField[] {
    return CLAUDE_SUBAGENT_FIELDS;
  },

  async writeDefinition(workspaceFs, attributes: RepoAgentAttributes): Promise<void> {
    const name = toScalar(attributes.name);
    await workspaceFs.write(definitionRelPath(name), serializeDefinition(attributes));
  },

  async readDefinition(workspaceFs, name): Promise<RepoAgentAttributes | null> {
    const content = await workspaceFs.read(definitionRelPath(name));
    if (content === null) return null;
    const fields = parseFrontmatterFields(content);

    const attributes: RepoAgentAttributes = {
      name: fields.name ?? name,
      description: fields.description ?? '',
      [BODY_KEY]: extractBody(content),
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

  async removeLocal(workspaceFs, name): Promise<void> {
    await workspaceFs.delete(definitionRelPath(name));
    await workspaceFs.delete(neutralSettingsRelPath(name));
    await workspaceFs.delete(settingsRelPath(name));
  },
};
