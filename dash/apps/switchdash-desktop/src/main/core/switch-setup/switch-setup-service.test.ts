import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  resolveCommandPath: vi.fn(),
  getPlugin: vi.fn(),
  listPlugins: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('@main/core/execution-context/local-execution-context', () => ({
  LocalExecutionContext: class {
    exec = mocks.exec;
  },
}));

vi.mock('@switchdash/core/deps/runtime', () => ({
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
const CODEX_INSTALL_PATH = '/cache/codex/plugins/switch-connector-codex';
const CODEX_MARKET_ROOT = '/cache/codex/marketplaces/switch-plugins';

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

function codexReadFileImpl(installedManifestVersion: string, advertisedVersion: string) {
  return (path: string) => {
    if (path === `${CODEX_INSTALL_PATH}/.codex-plugin/plugin.json`) {
      return Promise.resolve(JSON.stringify({ version: installedManifestVersion }));
    }
    if (path === `${CODEX_MARKET_ROOT}/.claude-plugin/marketplace.json`) {
      return Promise.resolve(
        JSON.stringify({
          plugins: [{ name: 'switch-connector-codex', source: './connectors/codex-plugin' }],
        })
      );
    }
    if (path === `${CODEX_MARKET_ROOT}/connectors/codex-plugin/.codex-plugin/plugin.json`) {
      return Promise.resolve(JSON.stringify({ version: advertisedVersion }));
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

describe('switchSetupService.listOnboardable', () => {
  it('returns only Switch-supported agent types whose connector is installed', async () => {
    mocks.listPlugins.mockReturnValue([CLI_AGENT, NONE_AGENT]);
    mocks.exec.mockImplementation(execImpl('0.1.0'));
    mocks.readFile.mockImplementation(readFileImpl('0.1.0', '0.1.0'));

    const onboardable = await switchSetupService.listOnboardable();

    expect(onboardable).toEqual([{ agentId: 'claude' }]);
  });

  it('omits supported agent types whose connector is not installed', async () => {
    mocks.listPlugins.mockReturnValue([CLI_AGENT, NONE_AGENT]);
    mocks.exec.mockImplementation(execImpl(null));
    mocks.readFile.mockImplementation(readFileImpl('0.0.0', '0.1.0'));

    const onboardable = await switchSetupService.listOnboardable();

    expect(onboardable).toEqual([]);
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
              repo: 'sandbox-quantum/napoleon',
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

  it('reads the object-wrapped listings and the .codex-plugin manifest', async () => {
    // The CLI listing reports a stale 0.1.0; only a read of the install dir's
    // `.codex-plugin/plugin.json` (Claude's lives under `.claude-plugin/`) finds
    // the real 0.2.0, and every other path in the fixture is ENOENT.
    mocks.exec.mockImplementation(codexExecImpl('0.1.0'));
    mocks.readFile.mockImplementation(codexReadFileImpl('0.2.0', '0.3.0'));

    const status = await switchSetupService.getStatus('codex');

    expect(status).toMatchObject({
      supported: true,
      installed: true,
      installedVersion: '0.2.0',
      latestVersion: '0.3.0',
      updateAvailable: true,
    });
  });

  it('reports not-installed when the object-wrapped list is empty', async () => {
    mocks.exec.mockImplementation(codexExecImpl(null));
    mocks.readFile.mockImplementation(codexReadFileImpl('0.2.0', '0.3.0'));

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
    mocks.readFile.mockImplementation(codexReadFileImpl('0.1.0', '0.1.0'));

    const status = await switchSetupService.checkForUpdates('codex');

    expect(status.refreshError).toBeNull();
    expect(calls()).toContain('plugin marketplace upgrade switch-plugins');
    expect(calls()).not.toContain('plugin marketplace update switch-plugins');
  });

  it('updates by removing then re-adding, in that order', async () => {
    mocks.exec.mockImplementation(codexExecImpl('0.1.0'));

    const result = await switchSetupService.update('codex');

    expect(result.success).toBe(true);
    expect(calls()).toEqual([`plugin remove ${CODEX_REF}`, `plugin add ${CODEX_REF}`]);
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

    expect(calls()).toEqual([`plugin remove ${CODEX_REF}`, `plugin add ${CODEX_REF}`]);
    expect(result).toEqual({
      success: false,
      message:
        'Update failed: the plugin was removed but could not be reinstalled. Install it again from Settings → Agents.',
    });
  });
});
