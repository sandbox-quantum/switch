import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SWITCH_AGENT_RUNTIME_PIN } from '../../../distribution';
import { icon } from './icon';
import { OPENCODE_PLUGIN_CONTENT } from './plugin-file';
import { OPENCODE_SKILL_CONTENT } from './skill-file';
import {
  buildOpencodeSwitchConnector,
  OPENCODE_CONFIG_PATH,
  OPENCODE_SKILL_PATH,
} from './switch-connector';

// …/console/packages/plugins/src/agents/impl/opencode → repo root
const CONNECTOR_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'connectors',
  'opencode-plugin'
);

function connectorFile(...segments: string[]): string {
  return readFileSync(join(CONNECTOR_DIR, ...segments), 'utf8');
}

/**
 * `connectors/opencode-plugin/` is the source of truth for what this connector
 * is, the same as the two marketplace connectors — but nothing fetches it.
 * Switch Console writes the connector itself, so it carries its own copy of
 * these assets, and the two can drift with nothing to notice.
 *
 * Drift is silent in the worst way: the directory is what a reader reviews and
 * edits, while sessions run whatever the app embedded. Editing the connector
 * and shipping the old behaviour would look, in review, exactly like shipping
 * the new one.
 */
function memoryFs(files: Map<string, string>) {
  return {
    read: async (path: string) => files.get(path) ?? null,
    write: async (path: string, content: string) => void files.set(path, content),
    delete: async (path: string) => void files.delete(path),
    exists: async (path: string) => files.has(path),
    list: async () => [...files.keys()],
  };
}

async function install(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  await buildOpencodeSwitchConnector().install(memoryFs(files), { version: '1.0.0' });
  return files;
}

describe('opencode connector assets', () => {
  it('embeds the reporting plugin exactly as the connector ships it', () => {
    expect(OPENCODE_PLUGIN_CONTENT).toBe(connectorFile('plugin', 'switch-notifications.js'));
  });

  it('embeds the room-workflow skill exactly as the connector ships it', () => {
    expect(OPENCODE_SKILL_CONTENT).toBe(connectorFile('skills', 'switch', 'SKILL.md'));
  });

  it('registers the MCP server exactly as the connector declares it', async () => {
    const declared = JSON.parse(connectorFile('opencode.json')) as {
      mcp: Record<string, unknown>;
    };

    const files = await install();
    const written = JSON.parse(files.get(OPENCODE_CONFIG_PATH) ?? '{}') as {
      mcp: Record<string, unknown>;
    };

    expect(written.mcp.switch).toEqual(declared.mcp.switch);
  });

  /**
   * The tools without the instructions is the failure this guards. Registering
   * the MCP server is what an install visibly does, and it is easy to call that
   * the whole job: the session then has forty room tools and nothing telling it
   * how a room works. Shipping the skill in the connector directory does not
   * deliver it — OpenCode only reads skills it discovers on disk.
   */
  it('writes the skill where OpenCode discovers it', async () => {
    const files = await install();
    expect(files.get(OPENCODE_SKILL_PATH)).toBe(OPENCODE_SKILL_CONTENT);
  });

  it('names the skill directory to match the skill, as OpenCode requires', () => {
    const declaredName = /^---\n(?:.*\n)*?name:\s*"?([\w-]+)"?\s*$/m.exec(OPENCODE_SKILL_CONTENT);
    // …/skills/<dir>/SKILL.md — the folder OpenCode derives the skill name from.
    const directory = OPENCODE_SKILL_PATH.split('/').at(-2);

    expect(declaredName?.[1]).toBe(directory);
  });

  it('removes the skill on uninstall', async () => {
    const files = await install();
    await buildOpencodeSwitchConnector().uninstall(memoryFs(files));

    expect(files.has(OPENCODE_SKILL_PATH)).toBe(false);
  });

  it('pins the same agent runtime as the rest of the repo', () => {
    expect(connectorFile('opencode.json')).toContain(SWITCH_AGENT_RUNTIME_PIN);
  });

  it('declares a version for the connector', () => {
    const manifest = JSON.parse(connectorFile('package.json')) as {
      name?: string;
      version?: string;
    };
    expect(manifest.name).toBe('@sandboxaq/switch-connector-opencode');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// The mark is full-bleed and 4:5, so authored as-is it both overflowed the icon
// box — an inline SVG's own width/height win over the wrapper's size — and read
// far heavier than the glyph icons beside it.
describe('opencode icon', () => {
  const svg = icon.variants[0];

  it('is square and carries no intrinsic size, so the icon box decides how big it is', () => {
    for (const variant of [svg?.light, svg?.dark]) {
      expect(variant).toBeDefined();
      expect(variant).toContain('viewBox="0 0 24 24"');
      expect(variant).not.toMatch(/<svg[^>]*\swidth=/);
      expect(variant).not.toMatch(/<svg[^>]*\sheight=/);
    }
  });

  it('insets the mark rather than filling the box edge to edge', () => {
    expect(svg?.light).toMatch(/translate\(/);
    expect(svg?.dark).toMatch(/translate\(/);
  });
});
