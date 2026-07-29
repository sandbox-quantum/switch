import { describe, expect, it } from 'vitest';
import { cliRulesFor } from './switch-setup-cli-dialect';

/**
 * Verbatim `codex plugin list --json` output, captured from Codex CLI 0.145.0.
 * Kept literal so a future Codex change that renames a field fails here rather
 * than silently reporting the connector as never installed.
 */
const CODEX_PLUGIN_LIST = JSON.stringify({
  installed: [
    {
      pluginId: 'switch-connector-codex@switch-plugins',
      name: 'switch-connector-codex',
      marketplaceName: 'switch-plugins',
      version: '0.1.0',
      installed: true,
      enabled: true,
      source: { source: 'local', path: '/repo/connectors/codex-plugin' },
    },
  ],
  available: [],
});

/** Verbatim `codex plugin marketplace list --json` output (Codex CLI 0.145.0). */
const CODEX_MARKETPLACE_LIST = JSON.stringify({
  marketplaces: [
    {
      name: 'switch-plugins',
      root: '/repo',
      marketplaceSource: { sourceType: 'local', source: '/repo' },
    },
  ],
});

describe('codex dialect', () => {
  const rules = cliRulesFor('codex');

  it('reads the installed plugin from the object-wrapped list', () => {
    // Claude's shape uses `id`/`installPath`; Codex uses `pluginId`/`source.path`.
    // Parsing Codex output with Claude's reader yields nothing, which is how the
    // connector would look permanently uninstalled without this dialect.
    expect(rules.parsePluginList(JSON.parse(CODEX_PLUGIN_LIST))).toEqual([
      {
        ref: 'switch-connector-codex@switch-plugins',
        version: '0.1.0',
        manifestPath: '/repo/connectors/codex-plugin',
      },
    ]);
    expect(cliRulesFor('claude-code').parsePluginList(JSON.parse(CODEX_PLUGIN_LIST))).toEqual([]);
  });

  it('reads marketplaces from the object-wrapped list', () => {
    expect(rules.parseMarketplaceList(JSON.parse(CODEX_MARKETPLACE_LIST))).toEqual([
      { name: 'switch-plugins', source: '/repo', root: '/repo' },
    ]);
  });

  it('uses add/remove, no scope flag, and has no per-plugin update verb', () => {
    expect(rules.installArgs('p@m', 'user')).toEqual(['plugin', 'add', 'p@m']);
    expect(rules.uninstallArgs('p@m', 'user')).toEqual(['plugin', 'remove', 'p@m']);
    // Null is the signal for callers to fall back to remove-then-add.
    expect(rules.updateArgs('p@m', 'user')).toBeNull();
    expect(rules.marketplaceRefreshArgs('m')).toEqual(['plugin', 'marketplace', 'upgrade', 'm']);
  });

  it('reports no advertised versions, since Codex only versions installed plugins', () => {
    expect(rules.parseAdvertisedVersions(JSON.parse(CODEX_PLUGIN_LIST), 'switch-plugins').size).toBe(
      0
    );
  });

  it('looks for plugin manifests under .codex-plugin but marketplaces under .claude-plugin', () => {
    // Codex reads a Claude-style marketplace manifest, which is what lets one
    // marketplace file serve both CLIs.
    expect(rules.pluginManifestDir).toBe('.codex-plugin');
    expect(rules.marketplaceManifestDir).toBe('.claude-plugin');
  });
});

describe('claude-code dialect', () => {
  const rules = cliRulesFor('claude-code');

  it('reads a bare array or an {installed} wrapper', () => {
    const entry = { id: 'p@m', version: '1.2.3', installPath: '/cache/p' };
    const expected = [{ ref: 'p@m', version: '1.2.3', manifestPath: '/cache/p' }];
    expect(rules.parsePluginList([entry])).toEqual(expected);
    expect(rules.parsePluginList({ installed: [entry] })).toEqual(expected);
  });

  it('matches a marketplace on either repo or path', () => {
    expect(
      rules.parseMarketplaceList([{ name: 'm', repo: 'owner/repo', installLocation: '/loc' }])
    ).toEqual([{ name: 'm', source: 'owner/repo', root: '/loc' }]);
    expect(rules.parseMarketplaceList([{ name: 'm', path: '/src' }])).toEqual([
      { name: 'm', source: '/src', root: null },
    ]);
  });

  it('keeps install/uninstall/update with the scope flag', () => {
    expect(rules.installArgs('p@m', 'user')).toEqual(['plugin', 'install', 'p@m', '-s', 'user']);
    expect(rules.updateArgs('p@m', 'local')).toEqual(['plugin', 'update', 'p@m', '-s', 'local']);
    expect(rules.marketplaceRefreshArgs('m')).toEqual(['plugin', 'marketplace', 'update', 'm']);
  });
});

describe('parser robustness', () => {
  // These feed status reads on the settings page. Unexpected output must degrade
  // to "nothing found" rather than throw — a crash here blanks the whole page.
  it.each(['claude-code', 'codex'] as const)('%s tolerates junk input', (dialect) => {
    const rules = cliRulesFor(dialect);
    for (const junk of [null, undefined, 'not json', 42, [], {}, { installed: 'nope' }]) {
      expect(rules.parsePluginList(junk)).toEqual([]);
      expect(rules.parseMarketplaceList(junk)).toEqual([]);
    }
  });

  it('drops entries missing the identifying field rather than emitting partials', () => {
    expect(cliRulesFor('codex').parsePluginList({ installed: [{ version: '1.0.0' }] })).toEqual([]);
    expect(cliRulesFor('claude-code').parsePluginList([{ version: '1.0.0' }])).toEqual([]);
  });

  it('fails loudly on an unknown dialect', () => {
    expect(() => cliRulesFor('nope' as never)).toThrow(/No plugin-CLI rules for dialect/);
  });
});
