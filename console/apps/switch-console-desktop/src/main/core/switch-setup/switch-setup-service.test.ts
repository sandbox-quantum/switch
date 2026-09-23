import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  resolveCommandPath: vi.fn(),
  getPlugin: vi.fn(),
  listPlugins: vi.fn(),
  readFile: vi.fn(),
  trackEvent: vi.fn(),
  createPluginFs: vi.fn(),
}));

vi.mock('../providers/plugin-fs', () => ({ createPluginFs: mocks.createPluginFs }));

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
import { aDurationMs } from '@tooling/utils/telemetry-duration';
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
  it.each([true, false])(
    'requires a local Antigravity binary, not a separate connector: %s',
    async (installed) => {
      mocks.listPlugins.mockReturnValue([
        { metadata: { id: 'antigravity' }, capabilities: { switchSetup: { kind: 'none' } } },
      ]);
      mocks.resolveCommandPath.mockResolvedValue(
        installed ? '/usr/local/bin/antigravity-acp' : null
      );
      expect(await switchSetupService.listAgentTypeAvailability()).toEqual([
        {
          agentId: 'antigravity',
          available: installed,
          blockedReason: installed
            ? null
            : 'Install Antigravity ACP on this computer to use SDK sessions.',
          blockedKind: installed ? null : 'not-installed',
        },
      ]);
    }
  );

  it.each([true, false])(
    'requires a local Cursor binary, not a separate connector: %s',
    async (installed) => {
      mocks.listPlugins.mockReturnValue([
        { metadata: { id: 'cursor' }, capabilities: { switchSetup: { kind: 'none' } } },
      ]);
      mocks.resolveCommandPath.mockResolvedValue(installed ? '/usr/local/bin/agent' : null);
      expect(await switchSetupService.listAgentTypeAvailability()).toEqual([
        {
          agentId: 'cursor',
          available: installed,
          blockedReason: installed
            ? null
            : 'Install Cursor CLI on this computer to use ACP sessions.',
          blockedKind: installed ? null : 'not-installed',
        },
      ]);
    }
  );

  it('reports a Switch-supported type with its connector installed as available', async () => {
    mocks.listPlugins.mockReturnValue([CLI_AGENT, NONE_AGENT]);
    mocks.exec.mockImplementation(execImpl('0.1.0'));
    mocks.readFile.mockImplementation(readFileImpl('0.1.0', '0.1.0'));

    expect(await switchSetupService.listAgentTypeAvailability()).toEqual([
      { agentId: 'claude', available: true, blockedReason: null, blockedKind: null },
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

  /**
   * One broken plugin must not empty the list.
   *
   * This fans out over every agent type, so a status read that throws took the
   * whole picker down with it — nothing rendered at all, which is a worse answer
   * than the one unavailable row it should have been. The same condition the
   * mutating paths report as `files_unimplemented` is the one that did it.
   */
  it('keeps the other types when one plugin cannot be read at all', async () => {
    const BROKEN_FILES_AGENT = {
      metadata: { id: 'opencode' },
      capabilities: {
        switchSetup: { kind: 'files', artifact: 'switch-connector-opencode' },
        hostDependency: { binaryNames: ['opencode'] },
      },
      behavior: { switchSetup: {} },
    };
    mocks.listPlugins.mockReturnValue([CLI_AGENT, BROKEN_FILES_AGENT]);
    mocks.getPlugin.mockImplementation((id: string) =>
      id === 'opencode' ? BROKEN_FILES_AGENT : CLI_AGENT
    );
    mocks.exec.mockImplementation(execImpl('0.1.0'));
    mocks.readFile.mockImplementation(readFileImpl('0.1.0', '0.1.0'));

    const availability = await switchSetupService.listAgentTypeAvailability();

    expect(availability).toEqual([
      { agentId: 'claude', available: true, blockedReason: null },
      {
        agentId: 'opencode',
        available: false,
        blockedReason: expect.stringContaining('implements no behavior'),
      },
    ]);
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
      failure_reason: 'none',
      // Elapsed wall time: a real number, but not one a test can pin.
      duration_ms: aDurationMs,
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
    // The host CLI refused the plugin — distinct from the marketplace failing
    // to register, which is the other way this same button fails.
    expect(mocks.trackEvent).toHaveBeenCalledWith('connector_installed', {
      agent_type: 'claude',
      target: 'local',
      outcome: 'failure',
      failure_reason: 'install_command_failed',
      duration_ms: aDurationMs,
    });
  });

  it('reports nothing when the agent type has no Switch setup to attempt', async () => {
    // Not a failed install — there was never one to attempt. Reporting it would
    // put every agent type in the app into the connector failure rate.
    mocks.getPlugin.mockReturnValue(NONE_AGENT);

    const result = await switchSetupService.install('no-switch-agent');

    expect(result).toEqual({
      success: false,
      message: 'Switch setup is not supported for this agent.',
    });
    expect(mocks.trackEvent).not.toHaveBeenCalled();
  });

  it('reports `unsupported` when a declared connector has no binary to drive it', async () => {
    // The other way an install ends with nothing installed, and this one IS a
    // failure of what the user asked for: the agent type declares a CLI
    // connector and the host binary cannot be resolved. It used to be silenced
    // by the same flag as the case above while `update` and `uninstall`
    // reported it, so the condition looked like it only happened on update.
    mocks.getPlugin.mockReturnValue({
      ...CLI_AGENT,
      capabilities: { ...CLI_AGENT.capabilities, hostDependency: { binaryNames: [] } },
    });

    const result = await switchSetupService.install('claude');

    expect(result.success).toBe(false);
    expect(mocks.trackEvent).toHaveBeenCalledWith('connector_installed', {
      agent_type: 'claude',
      target: 'local',
      outcome: 'failure',
      failure_reason: 'unsupported',
      duration_ms: aDurationMs,
    });
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

    const result = await switchSetupService.update('codex', 'user');

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

    const result = await switchSetupService.update('codex', 'user');

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

    const result = await switchSetupService.update('codex', 'user');

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

    const result = await switchSetupService.update('codex', 'user');

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
  const install = vi.fn();
  const uninstall = vi.fn();
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
    behavior: { switchSetup: { files: { installedVersion, install, uninstall } } },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPlugin.mockReturnValue(FILES_AGENT);
    mocks.createPluginFs.mockReturnValue({});
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

  // The app writes this connector rather than driving a marketplace CLI for it,
  // and it is still a connector being installed.
  it('reports an install the app performs itself', async () => {
    install.mockResolvedValue(undefined);

    const result = await switchSetupService.install('opencode');

    expect(result).toEqual({ success: true });
    expect(mocks.trackEvent).toHaveBeenCalledWith('connector_installed', {
      agent_type: 'opencode',
      target: 'local',
      outcome: 'success',
      failure_reason: 'none',
      duration_ms: aDurationMs,
    });
  });

  it('reports its failure too', async () => {
    install.mockRejectedValue(new Error('permission denied'));

    const result = await switchSetupService.install('opencode');

    expect(result.success).toBe(false);
    // The app's own write failed. Nothing about a marketplace or a host CLI is
    // involved in this connector, and the code has to say so.
    expect(mocks.trackEvent).toHaveBeenCalledWith('connector_installed', {
      agent_type: 'opencode',
      target: 'local',
      outcome: 'failure',
      failure_reason: 'files_write_failed',
      duration_ms: aDurationMs,
    });
  });

  it('still answers, and still reports, when the connector implements nothing', async () => {
    // A plugin can declare a files connector and supply no behaviour for it.
    // The user asked for an install: they get a failure, not a rejected promise
    // reaching the UI as a stack trace with nothing recorded.
    mocks.getPlugin.mockReturnValue({ ...FILES_AGENT, behavior: { switchSetup: {} } });

    const result = await switchSetupService.install('opencode');

    expect(result.success).toBe(false);
    // Its own code, not `files_write_failed`: nothing was written because there
    // was nothing to write it with, which is a fault in the plugin rather than
    // on this machine — and the two would otherwise be one number.
    expect(mocks.trackEvent).toHaveBeenCalledWith('connector_installed', {
      agent_type: 'opencode',
      target: 'local',
      outcome: 'failure',
      failure_reason: 'files_unimplemented',
      duration_ms: aDurationMs,
    });
  });

  /**
   * A failed removal is not a failed write.
   *
   * Both go through the same helper, so without a code of its own a read-only
   * config directory on an uninstall is counted as the same thing as an install
   * that could not write — on the one connector kind these codes exist to
   * separate. The marketplace path has drawn this line all along.
   */
  it('separates a failed removal from a failed write', async () => {
    uninstall.mockRejectedValue(new Error('permission denied'));

    const result = await switchSetupService.uninstall('opencode');

    expect(result.success).toBe(false);
    expect(mocks.trackEvent).toHaveBeenCalledWith('connector_uninstalled', {
      agent_type: 'opencode',
      target: 'local',
      outcome: 'failure',
      failure_reason: 'files_remove_failed',
      duration_ms: aDurationMs,
    });
  });

  /**
   * `files_unimplemented` is a claim about the shipped app — this plugin ships
   * no behavior — so only the plugin actually being unimplemented may produce
   * it. A filesystem that cannot be built is a fault on the machine, and it
   * counts as the write failing; reporting it as the plugin's fault would put a
   * plugin-authoring defect and a machine fault in one number, and on the remote
   * driver it would blame the shipped app for a dead SSH channel.
   */
  it('does not blame the plugin for a failure that is not the plugin', async () => {
    mocks.createPluginFs.mockImplementation(() => {
      throw new Error('home directory is not readable');
    });

    const result = await switchSetupService.install('opencode');

    expect(result).toEqual({ success: false, message: 'home directory is not readable' });
    expect(mocks.trackEvent).toHaveBeenCalledWith('connector_installed', {
      agent_type: 'opencode',
      target: 'local',
      outcome: 'failure',
      failure_reason: 'files_write_failed',
      duration_ms: aDurationMs,
    });
  });
});

/**
 * The codes exist to tell apart failures a user experiences identically.
 *
 * Every case below reaches the UI as some variant of "it did not work", and
 * each one needs a different fix — a marketplace source that will not resolve,
 * a host CLI that refuses the plugin, an update that got halfway. Counting them
 * as one number answers none of those questions, which is what this pins.
 */
describe('why a connector operation failed', () => {
  function reported(name: string): Record<string, unknown> {
    const call = mocks.trackEvent.mock.calls.find((c) => c[0] === name);
    if (!call) throw new Error(`nothing reported ${name}`);
    return call[1] as Record<string, unknown>;
  }

  /** Every exec fails, except the listings the operation reads first. */
  function execFailingAfterListings(stderr: string) {
    return (_bin: string, args: string[] = []) => {
      const a = args.join(' ');
      if (a === 'plugin list --json' || a === 'plugin marketplace list --json') {
        return Promise.resolve({ stdout: JSON.stringify([]), stderr: '' });
      }
      return Promise.reject(Object.assign(new Error('boom'), { code: 1, stderr }));
    };
  }

  it('blames the marketplace when it is the marketplace that would not register', async () => {
    // An empty listing sends `install` through `marketplace add`, which fails
    // here — before the plugin command is ever reached.
    mocks.exec.mockImplementation(execFailingAfterListings('could not resolve source'));

    await switchSetupService.install('claude');

    expect(reported('connector_installed')).toMatchObject({
      outcome: 'failure',
      failure_reason: 'marketplace_failed',
    });
  });

  it('blames the update verb when the host has one and it failed', async () => {
    const base = execImpl('0.1.0');
    mocks.exec.mockImplementation((bin: string, args: string[] = []) => {
      if (args.join(' ').startsWith('plugin update')) {
        return Promise.reject(Object.assign(new Error('boom'), { code: 1, stderr: 'locked' }));
      }
      return base(bin, args);
    });

    await switchSetupService.update('claude', 'user');

    expect(reported('connector_updated')).toMatchObject({
      outcome: 'failure',
      failure_reason: 'update_command_failed',
      was_reinstall: false,
    });
  });

  it('blames the uninstall when a reinstall-style update cannot remove the old plugin', async () => {
    // Codex has no update verb, so an update is remove-then-add. Failing at the
    // remove leaves the previous connector in place: nothing was lost.
    mocks.getPlugin.mockReturnValue(CODEX_AGENT);
    mocks.resolveCommandPath.mockResolvedValue('/usr/bin/codex');
    const base = codexExecImpl('0.1.0');
    mocks.exec.mockImplementation((bin: string, args: string[] = []) => {
      if (args.join(' ') === `plugin remove ${CODEX_REF}`) {
        return Promise.reject(Object.assign(new Error('boom'), { code: 1, stderr: 'in use' }));
      }
      return base(bin, args);
    });

    await switchSetupService.update('codex', 'user');

    expect(reported('connector_updated')).toMatchObject({
      outcome: 'failure',
      failure_reason: 'uninstall_command_failed',
      was_reinstall: true,
    });
  });

  it('blames the install when a reinstall-style update removed the plugin and could not put it back', async () => {
    // The same button, one step later, and a materially worse outcome: the
    // agent now has no connector at all. `was_reinstall` alone cannot separate
    // this from the case above — both are true — so the code has to.
    mocks.getPlugin.mockReturnValue(CODEX_AGENT);
    mocks.resolveCommandPath.mockResolvedValue('/usr/bin/codex');
    const base = codexExecImpl('0.1.0');
    mocks.exec.mockImplementation((bin: string, args: string[] = []) => {
      if (args.join(' ') === `plugin add ${CODEX_REF}`) {
        return Promise.reject(Object.assign(new Error('boom'), { code: 1, stderr: 'no network' }));
      }
      return base(bin, args);
    });

    await switchSetupService.update('codex', 'user');

    expect(reported('connector_updated')).toMatchObject({
      outcome: 'failure',
      failure_reason: 'install_command_failed',
      was_reinstall: true,
    });
  });

  it('blames the uninstall command when removing the connector failed', async () => {
    mocks.exec.mockImplementation(execFailingAfterListings('permission denied'));

    await switchSetupService.uninstall('claude');

    expect(reported('connector_uninstalled')).toMatchObject({
      outcome: 'failure',
      failure_reason: 'uninstall_command_failed',
    });
  });

  it('reports no reason at all when the operation worked', async () => {
    // `none` rather than an absent property: every connector_installed then
    // carries the same keys, so a gap in the data is a send that went wrong
    // rather than an outcome nobody thought about.
    mocks.exec.mockImplementation(execImpl(null));

    await switchSetupService.install('claude');

    expect(reported('connector_installed')).toMatchObject({
      outcome: 'success',
      failure_reason: 'none',
    });
  });

  /**
   * The agent's own CLI not being installed is not a marketplace fault.
   *
   * Every command goes through that binary, so the first one fails and the rest
   * are consequences — and the first one is the marketplace listing. Reported as
   * `marketplace_failed` the whole condition reads as a broken plugin source and
   * sends whoever acts on it at the wrong repository, when what is missing is the
   * agent.
   */
  describe('when the agent CLI is not on the machine', () => {
    /** What a spawn of a binary that does not exist rejects with. */
    function enoent() {
      return () =>
        Promise.reject(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    }

    beforeEach(() => {
      mocks.resolveCommandPath.mockResolvedValue(null);
      mocks.exec.mockImplementation(enoent());
    });

    it.each([
      ['install', 'connector_installed'],
      ['update', 'connector_updated'],
      ['uninstall', 'connector_uninstalled'],
    ] as const)('says so on %s', async (verb, event) => {
      await (verb === 'update'
        ? switchSetupService.update('claude', 'user')
        : switchSetupService[verb]('claude'));

      expect(reported(event)).toMatchObject({
        outcome: 'failure',
        failure_reason: 'host_cli_missing',
      });
    });

    it('says which binary in the message the user reads', async () => {
      const result = await switchSetupService.install('claude');

      expect(result.message).toContain('claude');
    });
  });
});
