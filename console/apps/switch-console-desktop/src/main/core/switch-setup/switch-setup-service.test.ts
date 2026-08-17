import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  resolveCommandPath: vi.fn(),
  getPlugin: vi.fn(),
  listPlugins: vi.fn(),
  readFile: vi.fn(),
  trackEvent: vi.fn(),
}));

vi.mock('@main/core/execution-context/local-execution-context', () => ({
  LocalExecutionContext: class {
    exec = mocks.exec;
  },
}));

// Reaches the settings store, and through it the database, at import time.
vi.mock('@main/core/telemetry/telemetry-service', () => ({ trackEvent: mocks.trackEvent }));

vi.mock('@switch-console/core/deps/runtime', () => ({
  resolveCommandPath: mocks.resolveCommandPath,
}));

vi.mock('../providers/plugin-registry', () => ({
  getPlugin: mocks.getPlugin,
  listPlugins: mocks.listPlugins,
}));

vi.mock('node:fs/promises', () => ({
  readFile: mocks.readFile,
}));

vi.mock('@main/lib/logger', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { ARTIFACT_VERSIONS } from '@switch-console/shared';
import { switchSetupService } from './switch-setup-service';

const CLI_AGENT = {
  metadata: { id: 'claude' },
  capabilities: {
    switchSetup: {
      kind: 'cli',
      pluginName: 'switch-connector',
      marketplaceName: 'switch-plugins',
      marketplaceSource: 'sandbox-quantum/switch',
      scope: 'user',
      dialect: 'claude-code',
    },
    hostDependency: { binaryNames: ['claude'] },
  },
};

const CODEX_AGENT = {
  metadata: { id: 'codex' },
  capabilities: {
    switchSetup: {
      kind: 'cli',
      pluginName: 'switch-connector-codex',
      marketplaceName: 'switch-plugins',
      marketplaceSource: 'sandbox-quantum/switch',
      scope: 'user',
      dialect: 'codex',
    },
    hostDependency: { binaryNames: ['codex'] },
  },
};

const NONE_AGENT = {
  metadata: { id: 'no-switch-agent' },
  capabilities: {
    switchSetup: { kind: 'none' },
    hostDependency: { binaryNames: ['nosw'] },
  },
};

const INSTALL_PATH = '/cache/switch-plugins/switch-connector/0.1.0';
const MARKET_LOCATION = '/marketplaces/switch-plugins';

const CODEX_REF = 'switch-connector-codex@switch-plugins';
// Codex reports `source.path` as the marketplace SOURCE directory, not a
// per-install cache — see the verbatim 0.145.0 capture in
// switch-setup-cli-dialect.test.ts. For a local-path marketplace the installed
// plugin therefore IS the checkout, and the installed and advertised manifests
// resolve to the same file.
const CODEX_MARKET_ROOT = '/repo';
const CODEX_INSTALL_PATH = `${CODEX_MARKET_ROOT}/connectors/codex-plugin`;

/** Default happy-path exec: installed 0.1.0, marketplace present. */
function execImpl(installedVersion: string | null) {
  return (_bin: string, args: string[] = []) => {
    const a = args.join(' ');
    if (a === 'plugin list --json') {
      const list =
        installedVersion === null
          ? []
          : [
              {
                id: 'switch-connector@switch-plugins',
                version: installedVersion,
                scope: 'user',
                installPath: INSTALL_PATH,
              },
            ];
      return Promise.resolve({ stdout: JSON.stringify(list), stderr: '' });
    }
    if (a === 'plugin marketplace list --json') {
      return Promise.resolve({
        stdout: JSON.stringify([
          {
            name: 'switch-plugins',
            source: 'github',
            repo: 'sandbox-quantum/switch',
            installLocation: MARKET_LOCATION,
          },
        ]),
        stderr: '',
      });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  };
}

/**
 * Codex's CLI wraps both listings in an object and names its fields differently
 * (`pluginId`/`source.path`, `marketplaces`/`marketplaceSource`), so the shapes
 * are spelled out here rather than reusing the Claude fixtures.
 */
function codexExecImpl(installedVersion: string | null) {
  return (_bin: string, args: string[] = []) => {
    const a = args.join(' ');
    if (a === 'plugin list --json') {
      return Promise.resolve({
        stdout: JSON.stringify({
          installed:
            installedVersion === null
              ? []
              : [
                  {
                    pluginId: CODEX_REF,
                    name: 'switch-connector-codex',
                    marketplaceName: 'switch-plugins',
                    version: installedVersion,
                    installed: true,
                    enabled: true,
                    source: { source: 'local', path: CODEX_INSTALL_PATH },
                  },
                ],
          available: [],
        }),
        stderr: '',
      });
    }
    if (a === 'plugin marketplace list --json') {
      return Promise.resolve({
        stdout: JSON.stringify({
          marketplaces: [
            {
              name: 'switch-plugins',
              root: CODEX_MARKET_ROOT,
              marketplaceSource: { sourceType: 'github', source: 'sandbox-quantum/switch' },
            },
          ],
        }),
        stderr: '',
      });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  };
}

function codexReadFileImpl(manifestVersion: string) {
  return (path: string) => {
    if (path === `${CODEX_INSTALL_PATH}/.codex-plugin/plugin.json`) {
      return Promise.resolve(JSON.stringify({ version: manifestVersion }));
    }
    // Present, and wrong, so a reader that went to Claude's manifest dir is
    // caught rather than accidentally passing.
    if (path === `${CODEX_INSTALL_PATH}/.claude-plugin/plugin.json`) {
      return Promise.resolve(JSON.stringify({ version: '9.9.9' }));
    }
    if (path === `${CODEX_MARKET_ROOT}/.claude-plugin/marketplace.json`) {
      return Promise.resolve(
        JSON.stringify({
          plugins: [{ name: 'switch-connector-codex', source: './connectors/codex-plugin' }],
        })
      );
    }
    return Promise.reject(new Error('ENOENT'));
  };
}

function readFileImpl(installedManifestVersion: string, advertisedVersion: string) {
  return (path: string) => {
    if (path === `${INSTALL_PATH}/.claude-plugin/plugin.json`) {
      return Promise.resolve(JSON.stringify({ version: installedManifestVersion }));
    }
    if (path === `${MARKET_LOCATION}/.claude-plugin/marketplace.json`) {
      return Promise.resolve(
        JSON.stringify({
          plugins: [{ name: 'switch-connector', source: './connectors/claude-code-plugin' }],
        })
      );
    }
    if (path === `${MARKET_LOCATION}/connectors/claude-code-plugin/.claude-plugin/plugin.json`) {
      return Promise.resolve(JSON.stringify({ version: advertisedVersion }));
    }
    return Promise.reject(new Error('ENOENT'));
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveCommandPath.mockResolvedValue('/usr/bin/claude');
  mocks.getPlugin.mockReturnValue(CLI_AGENT);
});

describe('switchSetupService.getStatus', () => {
  it('reports unsupported for agents with kind: none', async () => {
    mocks.getPlugin.mockReturnValue(NONE_AGENT);
    const status = await switchSetupService.getStatus('no-switch-agent');
    expect(status.supported).toBe(false);
    expect(status.installed).toBe(false);
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it('flags an update when the advertised version is newer than installed', async () => {
    mocks.exec.mockImplementation(execImpl('0.1.0'));
    mocks.readFile.mockImplementation(readFileImpl('0.1.0', '0.1.9'));

    const status = await switchSetupService.getStatus('claude');

    expect(status).toMatchObject({
      supported: true,
      installed: true,
      installedVersion: '0.1.0',
      latestVersion: '0.1.9',
      updateAvailable: true,
    });
  });

  it('prefers the install-dir manifest version over the list version field', async () => {
    // list reports a stale 0.1.0; the install-dir manifest is the truth (0.1.9)
    mocks.exec.mockImplementation(execImpl('0.1.0'));
    mocks.readFile.mockImplementation(readFileImpl('0.1.9', '0.1.9'));

    const status = await switchSetupService.getStatus('claude');

    expect(status.installedVersion).toBe('0.1.9');
    expect(status.updateAvailable).toBe(false);
  });

  it('reports not-installed when the plugin is absent', async () => {
    mocks.exec.mockImplementation(execImpl(null));
    mocks.readFile.mockImplementation(readFileImpl('0.0.0', '0.1.9'));

    const status = await switchSetupService.getStatus('claude');

    expect(status.installed).toBe(false);
    expect(status.installedVersion).toBeNull();
    expect(status.updateAvailable).toBe(false);
  });
});

describe('switchSetupService.listAgentTypeAvailability', () => {
  it('reports a Switch-supported type with its connector installed as available', async () => {
    mocks.listPlugins.mockReturnValue([CLI_AGENT, NONE_AGENT]);
    mocks.exec.mockImplementation(execImpl('0.1.0'));
    mocks.readFile.mockImplementation(readFileImpl('0.1.0', '0.1.0'));

    expect(await switchSetupService.listAgentTypeAvailability()).toEqual([
      { agentId: 'claude', available: true, blockedReason: null },
    ]);
  });

  /**
   * The type is still listed — that is the point of the change (CHOO-1809).
   *
   * Dropping it made "not set up here" indistinguishable from "does not exist":
   * the dropdown simply had one fewer row and the user was left to guess why the
   * agent they use every day was missing.
   */
  it('keeps a type whose connector is not installed, and says why it cannot be used', async () => {
    mocks.listPlugins.mockReturnValue([CLI_AGENT, NONE_AGENT]);
    mocks.exec.mockImplementation(execImpl(null));
    mocks.readFile.mockImplementation(readFileImpl('0.0.0', '0.1.0'));

    const availability = await switchSetupService.listAgentTypeAvailability();

    expect(availability).toHaveLength(1);
    expect(availability[0]!).toMatchObject({ agentId: 'claude', available: false });
    expect(availability[0]!.blockedReason).toBeTruthy();
  });

  it('never lists an agent type that declares no Switch setup', async () => {
    // `NONE_AGENT` cannot be onboarded at all, so it is not a thing the user
    // could fix — listing it greyed out would be noise, not information.
    mocks.listPlugins.mockReturnValue([CLI_AGENT, NONE_AGENT]);
    mocks.exec.mockImplementation(execImpl('0.1.0'));
    mocks.readFile.mockImplementation(readFileImpl('0.1.0', '0.1.0'));

    const availability = await switchSetupService.listAgentTypeAvailability();

    expect(availability.map((entry) => entry.agentId)).not.toContain(NONE_AGENT.metadata.id);
  });
});

describe('switchSetupService.checkForUpdates', () => {
  function calls(): string[] {
    return mocks.exec.mock.calls.map((c) => (c[1] as string[]).join(' '));
  }

  it('leaves a marketplace already pointing at the expected source alone', async () => {
    mocks.exec.mockImplementation(execImpl('0.1.0'));
    mocks.readFile.mockImplementation(readFileImpl('0.1.0', '0.1.0'));

    const status = await switchSetupService.checkForUpdates('claude');

    expect(status.refreshError).toBeNull();
    expect(calls()).not.toContain('plugin marketplace remove switch-plugins');
    expect(calls()).toContain('plugin marketplace update switch-plugins');
  });

  it('re-points a same-named marketplace registered against a different source', async () => {
    const base = execImpl('0.1.0');
    mocks.exec.mockImplementation((bin: string, args: string[] = []) => {
      if (args.join(' ') === 'plugin marketplace list --json') {
        return Promise.resolve({
          stdout: JSON.stringify([
            {
              name: 'switch-plugins',
              source: 'github',
              repo: 'sandbox-quantum/switch-legacy',
              installLocation: MARKET_LOCATION,
            },
          ]),
          stderr: '',
        });
      }
      return base(bin, args);
    });
    mocks.readFile.mockImplementation(readFileImpl('0.1.0', '0.1.9'));

    const status = await switchSetupService.checkForUpdates('claude');

    expect(calls()).toContain('plugin marketplace remove switch-plugins');
    expect(calls()).toContain('plugin marketplace add sandbox-quantum/switch');
    expect(status.refreshError).toBeNull();
    expect(status.updateAvailable).toBe(true);
  });

  it('surfaces refreshError with cached status when the marketplace update fails', async () => {
    const base = execImpl('0.1.0');
    mocks.exec.mockImplementation((bin: string, args: string[] = []) => {
      if (args.join(' ') === 'plugin marketplace update switch-plugins') {
        return Promise.reject(
          Object.assign(new Error('boom'), { code: 1, stderr: 'repository not found' })
        );
      }
      return base(bin, args);
    });
    mocks.readFile.mockImplementation(readFileImpl('0.1.0', '0.1.0'));

    const status = await switchSetupService.checkForUpdates('claude');

    expect(status.refreshError).toBe('repository not found');
    expect(status.installedVersion).toBe('0.1.0');
    expect(status.updateAvailable).toBe(false);
  });

  it('surfaces refreshError when re-adding the marketplace fails', async () => {
    mocks.exec.mockImplementation((_bin: string, args: string[] = []) => {
      const a = args.join(' ');
      if (a === 'plugin list --json') {
        return Promise.resolve({ stdout: JSON.stringify([]), stderr: '' });
      }
      if (a === 'plugin marketplace list --json') {
        return Promise.resolve({ stdout: JSON.stringify([]), stderr: '' });
      }
      return Promise.reject(
        Object.assign(new Error('boom'), { code: 1, stderr: 'could not resolve source' })
      );
    });
    mocks.readFile.mockImplementation(() => Promise.reject(new Error('ENOENT')));

    const status = await switchSetupService.checkForUpdates('claude');

    expect(status.refreshError).toBe('could not resolve source');
  });
});

describe('switchSetupService mutations', () => {
  it('install issues the scoped install command (marketplace already present)', async () => {
    mocks.exec.mockImplementation(execImpl(null));

    const result = await switchSetupService.install('claude');

    expect(result.success).toBe(true);
    expect(mocks.exec).toHaveBeenCalledWith(
      '/usr/bin/claude',
      ['plugin', 'install', 'switch-connector@switch-plugins', '-s', 'user'],
      expect.anything()
    );
    expect(mocks.trackEvent).toHaveBeenCalledWith('connector_installed', {
      agent_type: 'claude',
      target: 'local',
      outcome: 'success',
    });
  });

  it('uninstall issues the scoped uninstall command', async () => {
    mocks.exec.mockImplementation(execImpl('0.1.0'));

    const result = await switchSetupService.uninstall('claude');

    expect(result.success).toBe(true);
    expect(mocks.exec).toHaveBeenCalledWith(
      '/usr/bin/claude',
      ['plugin', 'uninstall', 'switch-connector@switch-plugins', '-s', 'user'],
      expect.anything()
    );
  });

  it('surfaces a failure message when the CLI exits non-zero', async () => {
    mocks.exec.mockImplementation((_bin: string, args: string[] = []) => {
      if (args.join(' ') === 'plugin marketplace list --json') {
        return Promise.resolve({
          stdout: JSON.stringify([
            {
              name: 'switch-plugins',
              source: 'github',
              repo: 'sandbox-quantum/switch',
              installLocation: MARKET_LOCATION,
            },
          ]),
          stderr: '',
        });
      }
      // install fails
      return Promise.reject(
        Object.assign(new Error('boom'), { code: 1, stderr: 'no write access' })
      );
    });

    const result = await switchSetupService.install('claude');

    expect(result.success).toBe(false);
    expect(result.message).toBe('no write access');
    expect(mocks.trackEvent).toHaveBeenCalledWith('connector_installed', {
      agent_type: 'claude',
      target: 'local',
      outcome: 'failure',
    });
  });

  it('reports nothing when the agent type has no Switch setup to attempt', async () => {
    mocks.getPlugin.mockReturnValue(NONE_AGENT);

    const result = await switchSetupService.install('no-switch-agent');

    expect(result).toEqual({
      success: false,
      message: 'Switch setup is not supported for this agent.',
    });
    expect(mocks.trackEvent).not.toHaveBeenCalled();
  });
});

describe('switchSetupService with the codex dialect', () => {
  function calls(): string[] {
    return mocks.exec.mock.calls.map((c) => (c[1] as string[]).join(' '));
  }

  beforeEach(() => {
    mocks.getPlugin.mockReturnValue(CODEX_AGENT);
    mocks.resolveCommandPath.mockResolvedValue('/usr/bin/codex');
  });

  it('takes the installed version from the CLI and the advertised one from the manifest', async () => {
    // Codex copies the plugin into a versioned cache but reports `source.path`
    // as the marketplace SOURCE directory. Reading a manifest there would give
    // the advertised version and report it as installed, so a stale install
    // would claim to be up to date. The CLI's own `version` is the installed
    // one; the marketplace manifest under `.codex-plugin/` is the advertised
    // one. Claude's `.claude-plugin/plugin.json` sits alongside reporting
    // 9.9.9, so a reader that went to the wrong manifest dir fails here.
    mocks.exec.mockImplementation(codexExecImpl('0.1.0'));
    mocks.readFile.mockImplementation(codexReadFileImpl('0.2.0'));

    const status = await switchSetupService.getStatus('codex');

    expect(status).toMatchObject({
      supported: true,
      installed: true,
      installedVersion: '0.1.0',
      latestVersion: '0.2.0',
      updateAvailable: true,
    });
  });

  it('reports up to date when the installed version matches the marketplace', async () => {
    mocks.exec.mockImplementation(codexExecImpl('0.2.0'));
    mocks.readFile.mockImplementation(codexReadFileImpl('0.2.0'));

    expect(await switchSetupService.getStatus('codex')).toMatchObject({
      installedVersion: '0.2.0',
      latestVersion: '0.2.0',
      updateAvailable: false,
    });
  });

  it('reports not-installed when the object-wrapped list is empty', async () => {
    mocks.exec.mockImplementation(codexExecImpl(null));
    mocks.readFile.mockImplementation(codexReadFileImpl('0.2.0'));

    const status = await switchSetupService.getStatus('codex');

    expect(status).toMatchObject({
      supported: true,
      installed: false,
      installedVersion: null,
      updateAvailable: false,
    });
  });

  it('installs with add and no scope flag', async () => {
    mocks.exec.mockImplementation(codexExecImpl(null));

    const result = await switchSetupService.install('codex');

    expect(result.success).toBe(true);
    expect(mocks.exec).toHaveBeenCalledWith(
      '/usr/bin/codex',
      ['plugin', 'add', CODEX_REF],
      expect.anything()
    );
  });

  it('uninstalls with remove and no scope flag', async () => {
    mocks.exec.mockImplementation(codexExecImpl('0.1.0'));

    const result = await switchSetupService.uninstall('codex');

    expect(result.success).toBe(true);
    expect(mocks.exec).toHaveBeenCalledWith(
      '/usr/bin/codex',
      ['plugin', 'remove', CODEX_REF],
      expect.anything()
    );
  });

  it('refreshes the marketplace with upgrade rather than update', async () => {
    mocks.exec.mockImplementation(codexExecImpl('0.1.0'));
    mocks.readFile.mockImplementation(codexReadFileImpl('0.1.0'));

    const status = await switchSetupService.checkForUpdates('codex');

    expect(status.refreshError).toBeNull();
    expect(calls()).toContain('plugin marketplace upgrade switch-plugins');
    expect(calls()).not.toContain('plugin marketplace update switch-plugins');
  });

  it('repairs a stale marketplace before removing the installed plugin', async () => {
    // The destructive branch: with no per-plugin update verb, a marketplace still
    // pointing at a pre-migration source would fail the re-add *after* the remove
    // succeeded, leaving no connector at all.
    const base = codexExecImpl('0.1.0');
    mocks.exec.mockImplementation((bin: string, args: string[] = []) => {
      if (args.join(' ') === 'plugin marketplace list --json') {
        return Promise.resolve({
          stdout: JSON.stringify({
            marketplaces: [
              {
                name: 'switch-plugins',
                root: CODEX_MARKET_ROOT,
                marketplaceSource: {
                  sourceType: 'github',
                  source: 'sandbox-quantum/switch-legacy',
                },
              },
            ],
          }),
          stderr: '',
        });
      }
      return base(bin, args);
    });

    const result = await switchSetupService.update('codex');

    expect(result.success).toBe(true);
    const seen = calls();
    expect(seen).toContain('plugin marketplace remove switch-plugins');
    expect(seen).toContain('plugin marketplace add sandbox-quantum/switch');
    expect(seen.indexOf('plugin marketplace add sandbox-quantum/switch')).toBeLessThan(
      seen.indexOf(`plugin remove ${CODEX_REF}`)
    );
  });

  it('reports a marketplace failure without removing the installed plugin', async () => {
    mocks.exec.mockImplementation((_bin: string, args: string[] = []) => {
      const a = args.join(' ');
      if (a === 'plugin marketplace add sandbox-quantum/switch') {
        return Promise.reject(
          Object.assign(new Error('exit 1'), { code: 1, stderr: 'no network' })
        );
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    const result = await switchSetupService.update('codex');

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Could not add marketplace/);
    // Repairing first is what keeps this safe: nothing destructive ran.
    expect(calls()).not.toContain(`plugin remove ${CODEX_REF}`);
  });

  it('surfaces a refreshError when the codex marketplace upgrade fails', async () => {
    const base = codexExecImpl('0.1.0');
    mocks.exec.mockImplementation((bin: string, args: string[] = []) => {
      if (args.join(' ') === 'plugin marketplace upgrade switch-plugins') {
        return Promise.reject(Object.assign(new Error('exit 1'), { code: 1, stderr: 'offline' }));
      }
      return base(bin, args);
    });
    mocks.readFile.mockImplementation(codexReadFileImpl('0.1.0'));

    const status = await switchSetupService.checkForUpdates('codex');

    expect(status.refreshError).toMatch(/offline/);
    expect(status.installed).toBe(true);
  });

  it('updates by removing then re-adding, in that order', async () => {
    mocks.exec.mockImplementation(codexExecImpl('0.1.0'));

    const result = await switchSetupService.update('codex');

    expect(result.success).toBe(true);
    // The marketplace is repaired first: the re-add resolves against it, so a
    // stale source must not be discovered after the remove has succeeded.
    expect(calls()).toEqual([
      'plugin marketplace list --json',
      `plugin remove ${CODEX_REF}`,
      `plugin add ${CODEX_REF}`,
    ]);
  });

  it('reports the plugin as removed-but-not-reinstalled when the re-add fails', async () => {
    mocks.exec.mockImplementation((_bin: string, args: string[] = []) => {
      if (args.join(' ') === `plugin add ${CODEX_REF}`) {
        // With no stderr to relay, our own wording is all the user gets — and it
        // has to say the host now has no connector, not just "update failed".
        return Promise.reject(Object.assign(new Error('exit 1'), { code: 1, stderr: '' }));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    const result = await switchSetupService.update('codex');

    expect(calls().slice(-2)).toEqual([`plugin remove ${CODEX_REF}`, `plugin add ${CODEX_REF}`]);
    expect(result).toEqual({
      success: false,
      message:
        'Update failed: the plugin was removed but could not be reinstalled. Install it again from Settings → Agents.',
    });
  });
});

describe('file-based connector version', () => {
  const installedVersion = vi.fn();
  const FILES_AGENT = {
    metadata: { id: 'opencode' },
    capabilities: {
      switchSetup: {
        kind: 'files',
        connectorName: 'Switch connector',
        artifact: 'switch-connector-opencode',
      },
      hostDependency: { binaryNames: ['opencode'] },
    },
    behavior: { switchSetup: { files: { installedVersion } } },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPlugin.mockReturnValue(FILES_AGENT);
  });

  // The connector is versioned in its own directory and listed in the registry
  // beside the marketplace connectors. Reporting the app's version here would
  // put a number on the card that matches nothing the connector declares.
  it('reports the connector artifact version, not the app version', async () => {
    installedVersion.mockResolvedValue('0.1.0');

    const status = await switchSetupService.getStatus('opencode');

    expect(status.latestVersion).toBe(ARTIFACT_VERSIONS['switch-connector-opencode']);
    expect(status.installedVersion).toBe('0.1.0');
  });

  // Keying "update available" on the app version offered an update on every
  // app release, even one that rewrote the connector with identical bytes.
  it('offers no update when the installed connector is the current one', async () => {
    installedVersion.mockResolvedValue(ARTIFACT_VERSIONS['switch-connector-opencode']);

    const status = await switchSetupService.getStatus('opencode');

    expect(status.installed).toBe(true);
    expect(status.updateAvailable).toBe(false);
  });
});
