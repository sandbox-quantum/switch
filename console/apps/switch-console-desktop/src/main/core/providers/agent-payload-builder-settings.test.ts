import type { CLIAgentPluginProvider } from '@switch-console/core/agents/plugins';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unlike agent-payload-builder.test.ts, the settings service here is real: only the
// app_settings table behind it is an in-memory stand-in.
const rows = new Map<string, string>();

vi.mock('drizzle-orm', () => ({ eq: (_column: unknown, value: unknown) => value }));
vi.mock('@main/db/schema', () => ({ appSettings: { key: 'key', value: 'value' } }));
vi.mock('@main/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (key: string) => ({
          execute: async () => (rows.has(key) ? [{ key, value: rows.get(key) }] : []),
        }),
      }),
    }),
  },
}));

vi.mock('@main/core/providers/plugin-registry', () => ({
  getPlugin: vi.fn(),
  listPlugins: vi.fn().mockReturnValue([]),
}));
vi.mock('@main/core/dependencies/registry', () => ({
  getDependencyDescriptor: vi.fn().mockReturnValue(undefined),
  DEPENDENCIES: [],
}));

const { getPlugin } = await import('@main/core/providers/plugin-registry');
const { setAgentProviderCatalogue } =
  await import('@shared/core/providers/agent-provider-registry');
const { providerOverrideSettings } = await import('../settings/provider-settings-service');
const { buildAgentPayload } = await import('./agent-payload-builder');

const plugin = (id: string) =>
  ({
    metadata: { id, name: id, description: id, websiteUrl: `https://${id}.example.com` },
    capabilities: {
      hostDependency: { binaryNames: [id], installCommands: {}, updates: { kind: 'none' } },
      models: { kind: 'none' },
      effort: { kind: 'none' },
      prompt: { kind: 'argv', flag: '' },
      sessions: { kind: 'resumable' },
      autoApprove: { kind: 'supported' },
      mcp: { kind: 'none' },
      plugins: { kind: 'none' },
    },
    assets: { icon: { variants: [], invertInDark: false } },
    behavior: {},
    validate: () => [],
  }) as unknown as CLIAgentPluginProvider;

const catalogued = (id: string) => ({
  id,
  name: id,
  description: '',
  docUrl: '',
  cliLabel: id,
  loginCommand: id,
  knownAgentType: id,
});

beforeEach(() => {
  rows.clear();
  providerOverrideSettings.invalidateCache();
  setAgentProviderCatalogue([catalogued('claude')]);
  vi.mocked(getPlugin).mockImplementation((id: string) => plugin(id));
});

describe('buildAgentPayload with the real settings service', () => {
  it('carries a saved provider override into the payload settings', async () => {
    rows.set(
      'providerConfigs',
      JSON.stringify({ claude: { env: { CLAUDE_CONFIG_DIR: '/SENTINEL/config' } } })
    );
    const payload = await buildAgentPayload('claude', 'macos');
    expect(payload?.settings).toEqual({
      value: { env: { CLAUDE_CONFIG_DIR: '/SENTINEL/config' } },
      defaults: {},
      overrides: { env: { CLAUDE_CONFIG_DIR: '/SENTINEL/config' } },
    });
  });

  it('gives a known provider with nothing saved empty settings', async () => {
    const payload = await buildAgentPayload('claude', 'macos');
    expect(payload?.settings).toEqual({ value: {}, defaults: {}, overrides: {} });
  });
});
