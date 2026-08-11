import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SWITCH_AGENT_RUNTIME_PIN } from '../../../distribution';
import { OPENCODE_PLUGIN_CONTENT } from './plugin-file';
import { buildOpencodeSwitchConnector, OPENCODE_CONFIG_PATH } from './switch-connector';

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
describe('opencode connector assets', () => {
  it('embeds the reporting plugin exactly as the connector ships it', () => {
    expect(OPENCODE_PLUGIN_CONTENT).toBe(connectorFile('plugin', 'switch-notifications.js'));
  });

  it('registers the MCP server exactly as the connector declares it', async () => {
    const declared = JSON.parse(connectorFile('opencode.json')) as {
      mcp: Record<string, unknown>;
    };

    const files = new Map<string, string>();
    await buildOpencodeSwitchConnector().install(
      {
        read: async (path) => files.get(path) ?? null,
        write: async (path, content) => void files.set(path, content),
        delete: async (path) => void files.delete(path),
        exists: async (path) => files.has(path),
        list: async () => [...files.keys()],
      },
      { version: '1.0.0' }
    );
    const written = JSON.parse(files.get(OPENCODE_CONFIG_PATH) ?? '{}') as {
      mcp: Record<string, unknown>;
    };

    expect(written.mcp.switch).toEqual(declared.mcp.switch);
  });

  it('pins the same agent runtime as the rest of the repo', () => {
    expect(connectorFile('opencode.json')).toContain(SWITCH_AGENT_RUNTIME_PIN);
  });

  it('declares a version for the connector', () => {
    const manifest = JSON.parse(connectorFile('package.json')) as {
      name?: string;
      version?: string;
    };
    expect(manifest.name).toBe('switch-connector-opencode');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
