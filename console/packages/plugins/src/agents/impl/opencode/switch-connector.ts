import type { ISwitchSetupFilesBehavior, PluginFs } from '@switch-console/core/agents/plugins';
import { SWITCH_AGENT_RUNTIME_PIN } from '../../../distribution';
import { OPENCODE_SKILL_CONTENT } from './skill-file';

/**
 * OpenCode's global config, relative to the home directory. It reads several
 * files; this is the canonical one, and the one `opencode mcp add` writes.
 */
export const OPENCODE_CONFIG_PATH = '.config/opencode/opencode.json';

/**
 * Records what Switch Console installed, beside the config rather than inside
 * it. OpenCode validates its config against a published schema that rejects
 * unknown keys, so bookkeeping cannot ride along in `opencode.json` without
 * risking a config the agent refuses to start with.
 */
export const OPENCODE_CONNECTOR_MARKER_PATH = '.config/opencode/switch-connector.json';

/**
 * The room-workflow skill, in OpenCode's global skill directory.
 *
 * Global rather than per-workspace to match the MCP server it explains: that
 * is registered in the global config, so every OpenCode session on the machine
 * has the Switch tools whether or not Switch Console launched it. A skill
 * dropped in a workspace would leave those sessions holding forty room tools
 * and no instructions for using them.
 *
 * The directory name has to be the skill's own name — OpenCode discovers
 * `skills/<name>/SKILL.md` and rejects a skill whose frontmatter `name`
 * disagrees with its folder.
 */
export const OPENCODE_SKILL_PATH = '.config/opencode/skills/switch/SKILL.md';

/** The key the Switch MCP server is registered under. */
const SERVER_NAME = 'switch';

/**
 * npx has to fetch the runtime on a cold cache before the server answers, and
 * OpenCode's default startup allowance is 5s — short enough that the first
 * session after an install would routinely fail to see any Switch tools.
 */
const STARTUP_TIMEOUT_MS = 60_000;

type OpencodeConfig = {
  mcp?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * The Switch MCP server as OpenCode declares one.
 *
 * Mirrors `connectors/opencode-plugin/opencode.json`, which is the source of
 * truth for what this connector registers; `connector-assets.test.ts` fails if
 * the two disagree.
 *
 * Registered as a `local` (stdio) server, which is what keeps the credential
 * off disk: OpenCode spawns a local server with the full parent environment,
 * so the runtime inherits the `SWITCH_*` variables Switch Console already puts
 * in the session, and nothing secret is written into a config file that is
 * shared by every OpenCode session on the machine.
 *
 * Only keys OpenCode's schema declares may appear here — it rejects unknown
 * properties on an MCP entry outright, taking the whole config with them.
 */
function switchServerEntry(): Record<string, unknown> {
  return {
    type: 'local',
    command: ['npx', '-y', SWITCH_AGENT_RUNTIME_PIN],
    enabled: true,
    timeout: STARTUP_TIMEOUT_MS,
  };
}

function parseConfig(raw: string | null): OpencodeConfig {
  if (!raw?.trim()) return {};
  try {
    return JSON.parse(raw) as OpencodeConfig;
  } catch {
    // A config we cannot parse is not ours to rewrite: replacing it would
    // discard whatever the user has in there. Fail loudly instead.
    throw new Error(
      `${OPENCODE_CONFIG_PATH} is not valid JSON. Fix or move it, then install the Switch connector again.`
    );
  }
}

function serialize(config: OpencodeConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function buildOpencodeSwitchConnector(): ISwitchSetupFilesBehavior {
  return {
    async install(fs: PluginFs, { version }: { version: string }): Promise<string[]> {
      const config = parseConfig(await fs.read(OPENCODE_CONFIG_PATH));
      // OpenCode rewrites its own config to add `$schema` when it is missing;
      // writing it ourselves keeps that from showing up as a spurious change.
      config.$schema ??= 'https://opencode.ai/config.json';
      config.mcp = { ...config.mcp, [SERVER_NAME]: switchServerEntry() };
      await fs.write(OPENCODE_CONFIG_PATH, serialize(config));
      await fs.write(OPENCODE_SKILL_PATH, OPENCODE_SKILL_CONTENT);
      await fs.write(
        OPENCODE_CONNECTOR_MARKER_PATH,
        `${JSON.stringify({ version, runtime: SWITCH_AGENT_RUNTIME_PIN }, null, 2)}\n`
      );
      return [OPENCODE_CONFIG_PATH, OPENCODE_SKILL_PATH, OPENCODE_CONNECTOR_MARKER_PATH];
    },

    async uninstall(fs: PluginFs): Promise<void> {
      const raw = await fs.read(OPENCODE_CONFIG_PATH);
      if (raw !== null) {
        const config = parseConfig(raw);
        if (config.mcp && SERVER_NAME in config.mcp) {
          // Only our own entry: the user's other MCP servers live in this file.
          const { [SERVER_NAME]: _removed, ...rest } = config.mcp;
          config.mcp = rest;
          if (Object.keys(rest).length === 0) delete config.mcp;
          await fs.write(OPENCODE_CONFIG_PATH, serialize(config));
        }
      }
      await fs.delete(OPENCODE_SKILL_PATH);
      await fs.delete(OPENCODE_CONNECTOR_MARKER_PATH);
    },

    async installedVersion(fs: PluginFs): Promise<string | null> {
      const marker = await fs.read(OPENCODE_CONNECTOR_MARKER_PATH);
      if (!marker) return null;

      // The marker alone is not proof. Someone editing `opencode.json` by hand,
      // or `opencode mcp` rewriting it, can leave the marker behind with no
      // server registered — reporting that as installed hides the reason the
      // agent has no Switch tools.
      const config = parseConfig(await fs.read(OPENCODE_CONFIG_PATH));
      if (!config.mcp || !(SERVER_NAME in config.mcp)) return null;

      try {
        const parsed = JSON.parse(marker) as { version?: unknown };
        return typeof parsed.version === 'string' ? parsed.version : null;
      } catch {
        return null;
      }
    },
  };
}
