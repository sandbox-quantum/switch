import type { PluginFs } from '@switch-console/core/agents/plugins';
import { beforeEach, describe, expect, it } from 'vitest';
import { SWITCH_AGENT_RUNTIME_PIN } from '../../../distribution';
import {
  buildOpencodeSwitchConnector,
  OPENCODE_CONFIG_PATH,
  OPENCODE_CONNECTOR_MARKER_PATH,
} from './switch-connector';

function memoryFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  const fs: PluginFs = {
    read: async (path) => files.get(path) ?? null,
    write: async (path, content) => void files.set(path, content),
    delete: async (path) => void files.delete(path),
    exists: async (path) => files.has(path),
    list: async () => [...files.keys()],
  };
  return { fs, files };
}

function readConfig(files: Map<string, string>) {
  return JSON.parse(files.get(OPENCODE_CONFIG_PATH) ?? '{}') as {
    mcp?: Record<string, Record<string, unknown>>;
    $schema?: string;
  };
}

let connector: ReturnType<typeof buildOpencodeSwitchConnector>;

beforeEach(() => {
  connector = buildOpencodeSwitchConnector();
});

describe('install', () => {
  it('registers the Switch MCP server in the global opencode config', async () => {
    const { fs, files } = memoryFs();

    const written = await connector.install(fs, { version: '1.2.3' });

    const entry = readConfig(files).mcp?.switch;
    expect(entry).toEqual({
      type: 'local',
      command: ['npx', '-y', SWITCH_AGENT_RUNTIME_PIN],
      enabled: true,
      timeout: 60_000,
    });
    expect(written).toContain(OPENCODE_CONFIG_PATH);
  });

  // OpenCode spawns a local MCP server with the parent environment, so the
  // runtime picks up SWITCH_* from the session. Writing a token here would put
  // a live credential in a file shared by every OpenCode session on the machine.
  it('writes no credential into the config', async () => {
    const { fs, files } = memoryFs();

    await connector.install(fs, { version: '1.2.3' });

    const raw = files.get(OPENCODE_CONFIG_PATH) ?? '';
    expect(raw).not.toMatch(/SWITCH_API_TOKEN|Bearer|Authorization/i);
  });

  // OpenCode rejects unknown properties on an MCP entry and fails the whole
  // config with them, so the entry must use only keys its schema declares.
  it('uses only keys the opencode schema declares', async () => {
    const { fs, files } = memoryFs();

    await connector.install(fs, { version: '1.2.3' });

    const allowed = new Set(['type', 'command', 'cwd', 'environment', 'enabled', 'timeout']);
    for (const key of Object.keys(readConfig(files).mcp?.switch ?? {})) {
      expect(allowed).toContain(key);
    }
  });

  it("keeps the user's other MCP servers and unrelated config", async () => {
    const { fs, files } = memoryFs({
      [OPENCODE_CONFIG_PATH]: JSON.stringify({
        theme: 'dark',
        mcp: { other: { type: 'local', command: ['other'] } },
      }),
    });

    await connector.install(fs, { version: '1.2.3' });

    const config = readConfig(files) as Record<string, unknown> & {
      mcp?: Record<string, unknown>;
    };
    expect(config.theme).toBe('dark');
    expect(config.mcp?.other).toEqual({ type: 'local', command: ['other'] });
    expect(config.mcp?.switch).toBeDefined();
  });

  it('is idempotent', async () => {
    const { fs, files } = memoryFs();

    await connector.install(fs, { version: '1.2.3' });
    const first = files.get(OPENCODE_CONFIG_PATH);
    await connector.install(fs, { version: '1.2.3' });

    expect(files.get(OPENCODE_CONFIG_PATH)).toBe(first);
  });

  // A config we cannot parse is not ours to replace — doing so would silently
  // discard whatever the user had in it.
  it('refuses to rewrite a config it cannot parse', async () => {
    const { fs, files } = memoryFs({ [OPENCODE_CONFIG_PATH]: '{ not json' });

    await expect(connector.install(fs, { version: '1.2.3' })).rejects.toThrow(/not valid JSON/);
    expect(files.get(OPENCODE_CONFIG_PATH)).toBe('{ not json');
  });
});

describe('installedVersion', () => {
  it('reports the version the install recorded', async () => {
    const { fs } = memoryFs();
    await connector.install(fs, { version: '1.2.3' });

    expect(await connector.installedVersion(fs)).toBe('1.2.3');
  });

  it('reports nothing when never installed', async () => {
    const { fs } = memoryFs();
    expect(await connector.installedVersion(fs)).toBeNull();
  });

  // The marker alone is not proof: `opencode mcp` or a hand edit can drop the
  // server and leave it behind. Reporting installed then hides exactly why the
  // agent has no Switch tools.
  it('reports nothing when the marker survives but the server is gone', async () => {
    const { fs, files } = memoryFs();
    await connector.install(fs, { version: '1.2.3' });
    files.set(OPENCODE_CONFIG_PATH, JSON.stringify({ mcp: {} }));

    expect(await connector.installedVersion(fs)).toBeNull();
  });

  it('reports nothing when the marker is unreadable', async () => {
    const { fs, files } = memoryFs();
    await connector.install(fs, { version: '1.2.3' });
    files.set(OPENCODE_CONNECTOR_MARKER_PATH, 'not json');

    expect(await connector.installedVersion(fs)).toBeNull();
  });
});

describe('uninstall', () => {
  it('removes the Switch server and the marker', async () => {
    const { fs, files } = memoryFs();
    await connector.install(fs, { version: '1.2.3' });

    await connector.uninstall(fs);

    expect(readConfig(files).mcp?.switch).toBeUndefined();
    expect(files.has(OPENCODE_CONNECTOR_MARKER_PATH)).toBe(false);
    expect(await connector.installedVersion(fs)).toBeNull();
  });

  it("leaves the user's other MCP servers alone", async () => {
    const { fs, files } = memoryFs({
      [OPENCODE_CONFIG_PATH]: JSON.stringify({
        mcp: { other: { type: 'local', command: ['other'] } },
      }),
    });
    await connector.install(fs, { version: '1.2.3' });

    await connector.uninstall(fs);

    expect(readConfig(files).mcp).toEqual({ other: { type: 'local', command: ['other'] } });
  });

  it('is safe to run when nothing was installed', async () => {
    const { fs } = memoryFs();
    await expect(connector.uninstall(fs)).resolves.toBeUndefined();
  });
});
