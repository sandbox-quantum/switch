import type {
  RepoAgentField,
  SwitchLaunchProfile,
  SwitchLaunchSpecialization,
} from '@switch-console/core/agents/plugins';
import { LAUNCH_PROFILE_HOME_PLACEHOLDER } from '@switch-console/core/agents/plugins';

/**
 * The agent an OpenCode session runs as by default, and therefore the one a
 * per-agent setting has to land on.
 *
 * OpenCode's per-agent settings live under `agent.<name>`, and a fresh `opencode`
 * with no `--agent` runs `build`. Overriding `build` rather than defining a new
 * agent keeps the launch command unchanged — there is no name to pass — and
 * leaves the agent list the user sees as it was. Every key set here is one
 * OpenCode's own schema declares for an agent, so the override is a narrowing of
 * the built-in rather than a replacement of it.
 */
const OPENCODE_TARGET_AGENT = 'build';

/**
 * Where an agent's OpenCode config and instructions live, under the same
 * `.config/opencode` directory as the global config they layer over. Kept in
 * their own `switch/` subdirectory so it is obvious which files Switch Console
 * owns, and so removing an agent cannot take a user's file with it.
 */
const OPENCODE_PROFILE_DIR = '.config/opencode/switch';

/**
 * The profile name an agent maps to, used as the config filename stem.
 *
 * A Switch agent name is unique only *within a location*: two agents can share a
 * name in different directories, so the name alone would collide onto one file
 * and whichever launched second would overwrite the first's settings. The name
 * therefore carries a digest of `(workingDir, slug)` — the same `(dir, slug)` key
 * the Codex profile and `agentSidecarTmuxName` use — which also keeps `a.b` and
 * `a-b` distinct.
 */
export function opencodeProfileName(slug: string, workingDir: string): string {
  const plain = slug.replace(/[^A-Za-z0-9_-]/g, '-');
  return `${plain}-${profileDigest(workingDir, slug)}`;
}

/** FNV-1a over `workingDir\0slug`, base36 — short, stable, and dependency-free. */
function profileDigest(workingDir: string, slug: string): string {
  let hash = 0x811c9dc5;
  const input = `${workingDir} ${slug}`;
  for (let i = 0; i < input.length; i++) {
    hash = Math.imul(hash ^ input.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** Home-relative path of an agent's OpenCode config. */
function opencodeConfigRelativePath(slug: string, workingDir: string): string {
  return `${OPENCODE_PROFILE_DIR}/${opencodeProfileName(slug, workingDir)}.json`;
}

/** Home-relative path of an agent's instructions file, when it has one. */
function opencodeInstructionsRelativePath(slug: string, workingDir: string): string {
  return `${OPENCODE_PROFILE_DIR}/${opencodeProfileName(slug, workingDir)}.instructions.md`;
}

/** Home-relative files an agent's OpenCode profile occupies, for delete/rename teardown. */
export function opencodeProfilePaths(params: { slug: string; workingDir: string }): string[] {
  return [
    opencodeConfigRelativePath(params.slug, params.workingDir),
    opencodeInstructionsRelativePath(params.slug, params.workingDir),
  ];
}

/**
 * Values OpenCode accepts for a tool permission. Only the two ends are offered
 * per setting below; `ask` would stall an unattended session on a prompt nobody
 * is there to answer.
 */
const ALLOW = 'allow';
const DENY = 'deny';

/**
 * How each per-agent setting is collected and where it goes in the config.
 *
 * One declaration serves the form and the writer, so a new setting is one entry
 * here rather than a field list and a writer that can disagree.
 *
 * `path` is a dotted path, absent for a setting handled specially
 * (`instructions`, which is a file rather than a value). `scope` says what it is
 * relative to: the agent's own object (`agent.build.…`) for most, or the config
 * root for the few OpenCode keys that have no per-agent form. Everything is
 * collected as a string or a number, and blank means the key is omitted so the
 * user's own `opencode.json` decides — which is not the same as writing a
 * default-looking value over it.
 */
type OpencodeSetting = {
  field: RepoAgentField;
  /**
   * True for a setting that is a main attribute of the agent rather than an
   * advanced one. It is still rendered into the profile — OpenCode only reads
   * its own files — but it is collected once, provider-agnostically, so it is
   * not offered again in this provider's advanced form.
   */
  topLevel?: boolean;
  path?: string;
  scope?: 'agent' | 'config';
  toValue?: (raw: string) => unknown;
};

/**
 * Parse a numeric setting, dropping anything that is not a finite number.
 *
 * OpenCode ignores config keys it does not recognise and does not complain about
 * a value it cannot use, so a junk number would be silently inert. Leaving the
 * key out instead is the same outcome the user gets from a blank field, and does
 * not put `null` into a config that claims to be a number.
 */
const numeric = (raw: string): unknown => {
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

const OPENCODE_SETTINGS: OpencodeSetting[] = [
  {
    field: {
      key: 'model',
      label: 'Model',
      type: 'text',
      placeholder: 'e.g. anthropic/claude-sonnet-4-5 — blank uses the OpenCode default',
      help: 'Overrides the model for this agent only, as provider/model. Includes a local model: define the provider once in your OpenCode config and an agent can run against it.',
      catalogue: { kind: 'model' },
    },
    path: 'model',
  },
  {
    field: {
      key: 'variant',
      label: 'Reasoning variant',
      type: 'text',
      placeholder: 'e.g. high — blank uses the model default',
      help: "OpenCode's reasoning-effort control. Which values a model takes is the model's own business, so the choices follow the model above; most local models have none.",
      catalogue: { kind: 'model-variant', modelField: 'model' },
    },
    path: 'variant',
  },
  {
    field: {
      key: 'temperature',
      label: 'Temperature',
      type: 'number',
      placeholder: 'e.g. 0.2',
      help: 'How much randomness the model is allowed. Blank leaves it to the model.',
    },
    path: 'temperature',
    toValue: numeric,
  },
  {
    field: {
      key: 'topP',
      label: 'Top-p',
      type: 'number',
      placeholder: 'e.g. 0.9',
      help: 'Nucleus-sampling cutoff. Blank leaves it to the model.',
    },
    path: 'top_p',
    toValue: numeric,
  },
  {
    field: {
      key: 'maxSteps',
      label: 'Step limit',
      type: 'number',
      placeholder: 'e.g. 40',
      help: 'How many tool-calling steps the agent may take before it has to answer.',
    },
    path: 'maxSteps',
    toValue: numeric,
  },
  {
    field: {
      key: 'webSearch',
      label: 'Web search',
      type: 'select',
      options: [
        { value: '', label: 'Default' },
        { value: 'true', label: 'On' },
        { value: 'false', label: 'Off' },
      ],
      help: 'Whether this agent may search the web.',
    },
    // Web search is not a setting in OpenCode, it is a tool the agent is allowed
    // or denied. Written as a permission rather than under `tools`, which
    // OpenCode normalises into exactly this.
    path: 'permission.websearch',
    toValue: (raw) => (raw === 'true' ? ALLOW : DENY),
  },
  {
    field: {
      key: 'smallModel',
      label: 'Utility model',
      type: 'text',
      placeholder: 'e.g. ollama/gemma4:latest — blank uses your OpenCode default',
      help: 'The cheaper model OpenCode uses for background work like naming the conversation. Worth setting to match the model above when the point is to keep everything on one machine — otherwise that background work goes wherever your own config sends it.',
      catalogue: { kind: 'model' },
    },
    path: 'small_model',
    // Top-level: OpenCode has no per-agent utility model, so this is the one
    // setting here that applies to the session rather than to the agent. The
    // config file is per-agent, so writing it at the root is still per-agent.
    scope: 'config',
  },
  {
    field: {
      key: 'instructions',
      label: 'Instructions',
      type: 'textarea',
      placeholder: "Extra guidance for this agent, e.g. 'You are a careful reviewer…'",
      help: "Added to OpenCode's own instructions, the way an AGENTS.md is. Blank keeps OpenCode defaults.",
    },
    topLevel: true,
  },
];

/** The fields the "advanced configuration" form renders for an OpenCode agent. */
export function opencodeLaunchProfileFields(): RepoAgentField[] {
  return OPENCODE_SETTINGS.filter((setting) => !setting.topLevel).map((setting) => setting.field);
}

/** Set a dotted path within an object, creating the intermediate objects. */
function assign(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  const leaf = segments.pop() as string;
  let cursor = target;
  for (const segment of segments) {
    if (typeof cursor[segment] !== 'object' || cursor[segment] === null) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[leaf] = value;
}

/**
 * Build an agent's OpenCode config.
 *
 * The result is layered over the user's global `~/.config/opencode/opencode.json`
 * rather than replacing it: OpenCode deep-merges what `OPENCODE_CONFIG` names
 * onto what it already loaded, so the Switch MCP server registered there survives
 * without being restated here. That is also why nothing in this file registers
 * it — restating it would put a second copy of the runtime pin somewhere it could
 * drift.
 *
 * `instructionsPath`, when the agent has an instructions body, is the absolute
 * path of the file holding it. It is absolute because the config is read from the
 * home directory while the session runs in the repo, so a relative path would
 * resolve against the wrong root.
 *
 * Returns `null` when nothing is set, so an agent on the defaults gets no config
 * file and no `OPENCODE_CONFIG` pointing at one.
 */
export function buildOpencodeConfig(
  values: SwitchLaunchSpecialization,
  instructionsPath: string | null
): string | null {
  const agent: Record<string, unknown> = {};
  const config: Record<string, unknown> = {};

  // Driven off OpenCode's own settings rather than the collected keys, so a value
  // stored under a key OpenCode does not declare is left out rather than written.
  // That matters more here than elsewhere: OpenCode drops a config section
  // containing a key it does not recognise, silently and whole.
  for (const setting of OPENCODE_SETTINGS) {
    if (!setting.path) continue;
    const raw = values[setting.field.key];
    if (typeof raw !== 'string' || raw.trim() === '') continue;

    const value = setting.toValue ? setting.toValue(raw.trim()) : raw.trim();
    if (value === undefined) continue;
    assign(setting.scope === 'config' ? config : agent, setting.path, value);
  }

  if (instructionsPath) config.instructions = [instructionsPath];
  if (Object.keys(agent).length > 0) config.agent = { [OPENCODE_TARGET_AGENT]: agent };
  if (Object.keys(config).length === 0) return null;

  // OpenCode adds `$schema` to a config that lacks one; writing it avoids that
  // showing up as a change to a file Switch Console owns.
  return `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...config }, null, 2)}\n`;
}

/**
 * Compute an agent's OpenCode launch profile: the files to write under the home
 * directory and the environment that loads them.
 *
 * Unlike Codex there is no argv to return. OpenCode has no `--profile` or
 * `--config` flag; the only way to add a config file to a session is
 * `OPENCODE_CONFIG`, so the profile's whole contribution is an environment
 * variable naming the file it just wrote. The value has to be absolute and this
 * function is pure, so the home directory arrives as a placeholder the launch
 * surface fills in.
 *
 * An instructions body is a second file rather than a value in the config.
 * OpenCode's per-agent `prompt` takes text directly, but it *supplies* that
 * agent's system prompt rather than adding to it, which for a coding agent means
 * losing the operating instructions it needs to work. Top-level `instructions` is
 * the additive path — the same one an AGENTS.md takes — and it names files.
 */
export function opencodeLaunchProfile(params: {
  slug: string;
  workingDir: string;
  values: SwitchLaunchSpecialization;
}): SwitchLaunchProfile | null {
  const { slug, workingDir, values } = params;

  const instructions = values.instructions?.trim() ? values.instructions : null;
  const instructionsRelativePath = opencodeInstructionsRelativePath(slug, workingDir);
  const instructionsPath = instructions
    ? `${LAUNCH_PROFILE_HOME_PLACEHOLDER}/${instructionsRelativePath}`
    : null;

  const content = buildOpencodeConfig(values, instructionsPath);
  if (!content) return null;

  const configRelativePath = opencodeConfigRelativePath(slug, workingDir);
  return {
    files: [
      { relativePath: configRelativePath, content },
      ...(instructions ? [{ relativePath: instructionsRelativePath, content: instructions }] : []),
    ],
    args: [],
    env: { OPENCODE_CONFIG: `${LAUNCH_PROFILE_HOME_PLACEHOLDER}/${configRelativePath}` },
  };
}
