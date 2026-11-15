import { beforeEach, describe, expect, it, vi } from 'vitest';

// An in-memory stand-in for the app_settings table: one row per storage key.
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
    insert: () => ({
      values: (row: { key: string; value: string }) => ({
        onConflictDoUpdate: () => ({
          execute: async () => {
            rows.set(row.key, row.value);
          },
        }),
      }),
    }),
    delete: () => ({
      where: (key: string) => ({
        execute: async () => {
          rows.delete(key);
        },
      }),
    }),
  },
}));

// Imported before any catalogue is installed: building the service must not read it.
const { providerOverrideSettings } = await import('./provider-settings-service');
const { setAgentProviderCatalogue } =
  await import('@shared/core/providers/agent-provider-registry');

const provider = (id: string) => ({
  id,
  name: id,
  description: '',
  docUrl: '',
  cliLabel: id,
  loginCommand: id,
  knownAgentType: id,
});

const KEY = 'providerConfigs';
const SENTINEL = { claude: { env: { CLAUDE_CONFIG_DIR: '/SENTINEL/config' } } };

function stored() {
  const raw = rows.get(KEY);
  return raw === undefined ? undefined : JSON.parse(raw);
}

// What the provider RPC returns for the settings sheet.
const getSettings = (id: string) => providerOverrideSettings.getItemWithMeta(id);
const getDefaultSettings = async (id: string) =>
  (await providerOverrideSettings.getItemWithMeta(id))?.defaults ?? null;

beforeEach(() => {
  rows.clear();
  providerOverrideSettings.invalidateCache();
  setAgentProviderCatalogue([provider('claude'), provider('codex')]);
});

describe('provider settings for known providers', () => {
  it('returns a saved override even though no defaults are configured', async () => {
    rows.set(KEY, JSON.stringify(SENTINEL));
    expect(await getSettings('claude')).toEqual({
      value: SENTINEL.claude,
      defaults: {},
      overrides: SENTINEL.claude,
    });
  });

  it('returns empty metadata for a known provider with nothing saved', async () => {
    expect(await getSettings('codex')).toEqual({ value: {}, defaults: {}, overrides: {} });
    expect(await getDefaultSettings('codex')).toEqual({});
  });

  it('keeps an unknown provider absent, and its saved row through other edits and resets', async () => {
    rows.set(KEY, JSON.stringify({ ...SENTINEL, legacy: { extraArgs: '--old' } }));
    expect(await getSettings('legacy')).toBeNull();
    expect(await getDefaultSettings('legacy')).toBeNull();

    await providerOverrideSettings.updateItem('codex', { env: { A: '1' } });
    await providerOverrideSettings.updateItem('claude', {});
    expect(stored()).toEqual({ codex: { env: { A: '1' } }, legacy: { extraArgs: '--old' } });
    expect(await getSettings('legacy')).toBeNull();
  });

  it('round-trips edit, add, delete of env rows and an empty value', async () => {
    await providerOverrideSettings.updateItem('claude', {
      extraArgs: '--keep',
      env: { CLAUDE_CONFIG_DIR: '/SENTINEL/config', EMPTY: '' },
    });
    expect((await getSettings('claude'))?.value).toEqual({
      extraArgs: '--keep',
      env: { CLAUDE_CONFIG_DIR: '/SENTINEL/config', EMPTY: '' },
    });

    await providerOverrideSettings.updateItem('claude', {
      extraArgs: '--keep',
      env: { CLAUDE_CONFIG_DIR: '/SENTINEL/other' },
    });
    const edited = await getSettings('claude');
    expect(edited?.value.env).toEqual({ CLAUDE_CONFIG_DIR: '/SENTINEL/other' });
    expect(edited?.overrides.extraArgs).toBe('--keep');
  });

  it('stores nothing for the UI default path: env undefined and no args', async () => {
    // The settings sheet sends `env: undefined` when no variable is set.
    await providerOverrideSettings.updateItem('claude', { extraArgs: undefined, env: undefined });
    expect(stored()).toBeUndefined();
    expect(await getSettings('claude')).toEqual({ value: {}, defaults: {}, overrides: {} });
  });

  it('keeps an explicit empty env object as saved (existing store behaviour, not changed here)', async () => {
    // The sheet never sends `env: {}`, but the generic store keeps what it is given
    // when it differs from the default, and a provider has no env default.
    await providerOverrideSettings.updateItem('claude', { env: {} });
    expect(stored()).toEqual({ claude: { env: {} } });
    await providerOverrideSettings.updateItem('claude', {});
    expect(stored()).toBeUndefined();
  });

  it('reset clears only the selected provider and a re-read does not bring it back', async () => {
    rows.set(KEY, JSON.stringify({ ...SENTINEL, codex: { env: { A: '1' } } }));
    expect((await getSettings('claude'))?.overrides).toEqual(SENTINEL.claude);

    // The reset hook writes the defaults back.
    await providerOverrideSettings.updateItem('claude', (await getDefaultSettings('claude'))!);

    expect(await getSettings('claude')).toEqual({ value: {}, defaults: {}, overrides: {} });
    expect(await getSettings('codex')).toMatchObject({ overrides: { env: { A: '1' } } });
    expect(stored()).toEqual({ codex: { env: { A: '1' } } });
    expect(Object.keys(await providerOverrideSettings.getAll()).sort()).toEqual([
      'claude',
      'codex',
    ]);
  });
});

describe('catalogue timing', () => {
  it('reads the catalogue on use, not when the service is imported', async () => {
    // The module was imported above before any catalogue existed.
    setAgentProviderCatalogue([provider('opencode')]);
    expect(await getSettings('opencode')).toEqual({ value: {}, defaults: {}, overrides: {} });
    expect(await getSettings('claude')).toBeNull();
  });
});
