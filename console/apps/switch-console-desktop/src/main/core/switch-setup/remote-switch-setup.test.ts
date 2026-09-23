import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  resolveCommandPath: vi.fn(),
  getPlugin: vi.fn(),
  listPlugins: vi.fn(),
  ensureSshConnected: vi.fn(),
  trackEvent: vi.fn(),
}));

// Reaches the settings store, and through it the database, at import time.
vi.mock('@main/core/telemetry/telemetry-service', () => ({ trackEvent: mocks.trackEvent }));

vi.mock('@main/core/execution-context/ssh-execution-context', () => ({
  SshExecutionContext: class {
    exec = mocks.exec;
  },
}));

vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({
  ensureSshConnected: mocks.ensureSshConnected,
}));

vi.mock('@switch-console/core/deps/runtime', () => ({
  resolveCommandPath: mocks.resolveCommandPath,
}));

vi.mock('../providers/plugin-registry', () => ({
  getPlugin: mocks.getPlugin,
  listPlugins: mocks.listPlugins,
}));

vi.mock('@main/lib/logger', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { TransportError } from '@switch-console/core/exec';
import { aDurationMs } from '@tooling/utils/telemetry-duration';
import { getRemoteSwitchSetupService } from './remote-switch-setup';

const SSH_HOST = 'agent-host';

const CLAUDE_AGENT = {
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

const CODEX_REF = 'switch-connector-codex@switch-plugins';

/**
 * A login shell sources the host's profile before the command runs, so its MOTD
 * lands on stdout ahead of the JSON. This one carries brackets of its own, which
 * a naive "slice from the first bracket" would latch onto.
 */
const MOTD = [
  '###############################################',
  '#  ACME [production] — authorized use only    #',
  '#  Last login: Tue Jul 28 09:12:33 2026       #',
  '###############################################',
].join('\n');

function withBanner(json: string): string {
  return `${MOTD}\n${json}\nConnection to ${SSH_HOST} closed.\n`;
}

function claudeExecImpl(installedVersion: string, advertisedVersion: string) {
  return (_bin: string, args: string[] = []) => {
    const a = args.join(' ');
    if (a === 'plugin list --json') {
      return Promise.resolve({
        stdout: withBanner(
          JSON.stringify([
            {
              id: 'switch-connector@switch-plugins',
              version: installedVersion,
              scope: 'user',
              installPath: '/home/dev/.claude/plugins/switch-connector',
            },
          ])
        ),
        stderr: '',
      });
    }
    if (a === 'plugin marketplace list --json') {
      return Promise.resolve({
        stdout: withBanner(
          JSON.stringify([
            {
              name: 'switch-plugins',
              source: 'github',
              repo: 'sandbox-quantum/switch',
              installLocation: '/home/dev/.claude/marketplaces/switch-plugins',
              plugins: [{ name: 'switch-connector', version: advertisedVersion }],
            },
          ])
        ),
        stderr: '',
      });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  };
}

const CODEX_MARKET_ROOT = '/home/dev/.codex/marketplaces/switch-plugins';

/** The two manifests the marketplace fallback reads, keyed by absolute path. */
function codexManifests(advertisedVersion: string): Record<string, string> {
  return {
    [`${CODEX_MARKET_ROOT}/.claude-plugin/marketplace.json`]: JSON.stringify({
      plugins: [{ name: 'switch-connector-codex', source: 'connectors/codex-plugin' }],
    }),
    [`${CODEX_MARKET_ROOT}/connectors/codex-plugin/.codex-plugin/plugin.json`]: JSON.stringify({
      version: advertisedVersion,
    }),
  };
}

function codexExecImpl(marketplaceSource: string, manifests: Record<string, string> = {}) {
  return (bin: string, args: string[] = []) => {
    const a = args.join(' ');
    if (bin === 'cat') {
      const body = manifests[args[0] ?? ''];
      if (body === undefined) {
        return Promise.reject(
          Object.assign(new Error('cat: No such file or directory'), {
            code: 1,
            stdout: '',
            stderr: 'cat: No such file or directory',
          })
        );
      }
      return Promise.resolve({ stdout: body, stderr: '' });
    }
    if (a === 'plugin list --json') {
      return Promise.resolve({
        stdout: JSON.stringify({
          installed: [
            {
              pluginId: CODEX_REF,
              name: 'switch-connector-codex',
              marketplaceName: 'switch-plugins',
              version: '0.1.0',
              installed: true,
              enabled: true,
              source: { source: 'local', path: '/home/dev/.codex/plugins/switch-connector-codex' },
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
              marketplaceSource: { sourceType: 'github', source: marketplaceSource },
            },
          ],
        }),
        stderr: '',
      });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  };
}

function calls(): string[] {
  return mocks.exec.mock.calls.map((c) => (c[1] as string[]).join(' '));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureSshConnected.mockResolvedValue({});
  mocks.resolveCommandPath.mockResolvedValue('/usr/bin/codex');
  mocks.getPlugin.mockReturnValue(CODEX_AGENT);
});

describe('RemoteSwitchSetupService.getStatus', () => {
  it('parses CLI JSON printed after a login-shell banner', async () => {
    mocks.getPlugin.mockReturnValue(CLAUDE_AGENT);
    mocks.resolveCommandPath.mockResolvedValue('/usr/bin/claude');
    mocks.exec.mockImplementation(claudeExecImpl('0.1.0', '0.2.0'));

    const service = await getRemoteSwitchSetupService(SSH_HOST);
    const status = await service.getStatus('claude');

    expect(status).toMatchObject({
      supported: true,
      installed: true,
      installedVersion: '0.1.0',
      latestVersion: '0.2.0',
      updateAvailable: true,
    });
  });

  /**
   * Codex's marketplace listing carries no plugin versions, so the CLI alone can
   * never say whether an update exists. It does not follow that none does — the
   * versions are in the marketplace's manifests on the host, which is where the
   * local driver has always read them from.
   */
  describe('codex, whose CLI advertises no versions', () => {
    it('reads the advertised version from the marketplace manifests', async () => {
      mocks.exec.mockImplementation(
        codexExecImpl('sandbox-quantum/switch', codexManifests('0.2.0'))
      );

      const service = await getRemoteSwitchSetupService(SSH_HOST);
      const status = await service.getStatus('codex');

      expect(status).toMatchObject({
        supported: true,
        installed: true,
        installedVersion: '0.1.0',
        latestVersion: '0.2.0',
        updateAvailable: true,
      });
    });

    it('reports no update when the manifest matches what is installed', async () => {
      mocks.exec.mockImplementation(
        codexExecImpl('sandbox-quantum/switch', codexManifests('0.1.0'))
      );

      const service = await getRemoteSwitchSetupService(SSH_HOST);

      expect(await service.getStatus('codex')).toMatchObject({
        latestVersion: '0.1.0',
        updateAvailable: false,
      });
    });

    it('reports the latest version as unknown when the manifests cannot be read', async () => {
      // Unreadable manifests mean we do not know, which must not be rendered as
      // "up to date" — the stale-green this surface exists to avoid.
      mocks.exec.mockImplementation(codexExecImpl('sandbox-quantum/switch'));

      const service = await getRemoteSwitchSetupService(SSH_HOST);
      const status = await service.getStatus('codex');

      expect(status).toMatchObject({
        installed: true,
        installedVersion: '0.1.0',
        latestVersion: null,
        updateAvailable: false,
      });
    });

    it('reads each manifest once and does not re-read the plugin list', async () => {
      mocks.exec.mockImplementation(
        codexExecImpl('sandbox-quantum/switch', codexManifests('0.2.0'))
      );

      const service = await getRemoteSwitchSetupService(SSH_HOST);
      await service.getStatus('codex');

      expect(calls()).toEqual([
        'plugin list --json',
        'plugin marketplace list --json',
        `${CODEX_MARKET_ROOT}/.claude-plugin/marketplace.json`,
        `${CODEX_MARKET_ROOT}/connectors/codex-plugin/.codex-plugin/plugin.json`,
      ]);
    });
  });

  it('skips the marketplace manifests when the CLI already advertises versions', async () => {
    // Claude Code reports the advertised versions in `marketplace list --json`,
    // so that fallback is dead weight there — two SSH round trips per status
    // read. The installed version is still read from the plugin manifest, which
    // is the accurate source and the one the local driver uses: the CLI records
    // the version it installed and does not update it in place.
    mocks.getPlugin.mockReturnValue(CLAUDE_AGENT);
    mocks.resolveCommandPath.mockResolvedValue('/usr/bin/claude');
    mocks.exec.mockImplementation(claudeExecImpl('0.1.0', '0.2.0'));

    const service = await getRemoteSwitchSetupService(SSH_HOST);
    await service.getStatus('claude');

    expect(calls()).toEqual([
      'plugin list --json',
      '/home/dev/.claude/plugins/switch-connector/.claude-plugin/plugin.json',
      'plugin marketplace list --json',
    ]);
  });
});

describe('RemoteSwitchSetupService.update', () => {
  it('repairs a stale marketplace before removing the installed plugin', async () => {
    // With no per-plugin update verb the update is destructive: a marketplace
    // still pointing at a pre-migration source would fail the re-add *after* the
    // remove succeeded, leaving the host with no connector.
    mocks.exec.mockImplementation(codexExecImpl('sandbox-quantum/switch-legacy'));

    const service = await getRemoteSwitchSetupService(SSH_HOST);
    const result = await service.update('codex', 'user');

    expect(result.success).toBe(true);
    const seen = calls();
    expect(seen).toContain('plugin marketplace remove switch-plugins');
    expect(seen.indexOf('plugin marketplace add sandbox-quantum/switch')).toBeLessThan(
      seen.indexOf(`plugin remove ${CODEX_REF}`)
    );
  });

  it('reports a marketplace failure without removing the installed plugin', async () => {
    mocks.exec.mockImplementation((_bin: string, args: string[] = []) => {
      if (args.join(' ') === 'plugin marketplace add sandbox-quantum/switch') {
        return Promise.reject(
          Object.assign(new Error('exit 1'), { code: 1, stderr: 'no network' })
        );
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    const service = await getRemoteSwitchSetupService(SSH_HOST);
    const result = await service.update('codex', 'user');

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Could not add marketplace/);
    expect(calls()).not.toContain(`plugin remove ${CODEX_REF}`);
  });

  it('surfaces a refreshError when the codex marketplace upgrade fails', async () => {
    const base = codexExecImpl('sandbox-quantum/switch');
    mocks.exec.mockImplementation((bin: string, args: string[] = []) => {
      if (args.join(' ') === 'plugin marketplace upgrade switch-plugins') {
        return Promise.reject(Object.assign(new Error('exit 1'), { code: 1, stderr: 'offline' }));
      }
      return base(bin, args);
    });

    const service = await getRemoteSwitchSetupService(SSH_HOST);
    const status = await service.checkForUpdates('codex');

    expect(status.refreshError).toMatch(/offline/);
    expect(status.installed).toBe(true);
  });

  it('removes then re-adds for codex, which has no per-plugin update verb', async () => {
    mocks.exec.mockImplementation(codexExecImpl('sandbox-quantum/switch'));

    const service = await getRemoteSwitchSetupService(SSH_HOST);
    const result = await service.update('codex', 'user');

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

    const service = await getRemoteSwitchSetupService(SSH_HOST);
    const result = await service.update('codex', 'user');

    expect(calls().slice(-2)).toEqual([`plugin remove ${CODEX_REF}`, `plugin add ${CODEX_REF}`]);
    expect(result).toEqual({
      success: false,
      message:
        'Update failed: the plugin was removed but could not be reinstalled. Install it again for this host.',
    });
  });

  /**
   * The reinstall split, on the driver where it was not pinned.
   *
   * Both halves of a Codex update carry `was_reinstall: true`, so the flag alone
   * cannot tell "nothing changed" from "the host now has no connector". The
   * failure code is what separates them, and it has to be asserted on this
   * driver too — the two are maintained by hand and have drifted before.
   */
  it('reports the removal half of a failed reinstall', async () => {
    mocks.exec.mockImplementation((_bin: string, args: string[] = []) => {
      if (args.join(' ') === `plugin remove ${CODEX_REF}`) {
        return Promise.reject(Object.assign(new Error('exit 1'), { code: 1, stderr: 'locked' }));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    const service = await getRemoteSwitchSetupService(SSH_HOST);
    await service.update('codex', 'user');

    expect(mocks.trackEvent).toHaveBeenCalledWith('connector_updated', {
      agent_type: 'codex',
      target: 'remote',
      outcome: 'failure',
      was_reinstall: true,
      trigger: 'user',
      failure_reason: 'uninstall_command_failed',
      duration_ms: aDurationMs,
    });
  });

  it('reports the re-add half of a failed reinstall', async () => {
    mocks.exec.mockImplementation((_bin: string, args: string[] = []) => {
      if (args.join(' ') === `plugin add ${CODEX_REF}`) {
        return Promise.reject(Object.assign(new Error('exit 1'), { code: 1, stderr: '' }));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    const service = await getRemoteSwitchSetupService(SSH_HOST);
    await service.update('codex', 'user');

    expect(mocks.trackEvent).toHaveBeenCalledWith('connector_updated', {
      agent_type: 'codex',
      target: 'remote',
      outcome: 'failure',
      was_reinstall: true,
      trigger: 'user',
      failure_reason: 'install_command_failed',
      duration_ms: aDurationMs,
    });
  });

  it('reports a successful reinstall-style update', async () => {
    mocks.exec.mockImplementation(codexExecImpl('sandbox-quantum/switch'));

    const service = await getRemoteSwitchSetupService(SSH_HOST);
    await service.update('codex', 'user');

    expect(mocks.trackEvent).toHaveBeenCalledWith('connector_updated', {
      agent_type: 'codex',
      target: 'remote',
      outcome: 'success',
      was_reinstall: true,
      trigger: 'user',
      failure_reason: 'none',
      duration_ms: aDurationMs,
    });
  });
});

/**
 * An SSH channel that dies mid-operation is the most common way a remote
 * connector operation fails, and it arrives as a rejection rather than a result:
 * `resolveCommandPath` re-throws a transport failure by design, because it is
 * not evidence the binary is absent. Unreported, it is an attempt the user made
 * that no event records, and a stack in the renderer instead of a message.
 */
describe('RemoteSwitchSetupService transport failures', () => {
  beforeEach(() => {
    mocks.resolveCommandPath.mockRejectedValue(new Error('ssh channel closed'));
  });

  it('reports an install that threw rather than letting it escape', async () => {
    const service = await getRemoteSwitchSetupService(SSH_HOST);
    const result = await service.install('codex');

    expect(result).toEqual({ success: false, message: 'ssh channel closed' });
    expect(mocks.trackEvent).toHaveBeenCalledWith('connector_installed', {
      agent_type: 'codex',
      target: 'remote',
      outcome: 'failure',
      failure_reason: 'error',
      duration_ms: aDurationMs,
    });
  });

  it('reports an update that threw, with nothing removed', async () => {
    const service = await getRemoteSwitchSetupService(SSH_HOST);
    const result = await service.update('codex', 'user');

    expect(result.success).toBe(false);
    expect(mocks.trackEvent).toHaveBeenCalledWith('connector_updated', {
      agent_type: 'codex',
      target: 'remote',
      outcome: 'failure',
      // Resolution throws before anything is removed, so the pair is not
      // counted as a half-finished reinstall.
      was_reinstall: false,
      trigger: 'user',
      failure_reason: 'error',
      duration_ms: aDurationMs,
    });
  });
});

describe('RemoteSwitchSetupService when the channel drops mid-operation', () => {
  function dropsOn(command: string) {
    return (_bin: string, args: string[] = []) =>
      args.join(' ') === command
        ? Promise.reject(new TransportError('SSH transport failure: channel closed'))
        : Promise.resolve({ stdout: '', stderr: '' });
  }

  it('does not blame the marketplace for a dead channel', async () => {
    mocks.exec.mockImplementation(dropsOn('plugin marketplace list --json'));

    const service = await getRemoteSwitchSetupService(SSH_HOST);
    await service.install('codex');

    expect(mocks.trackEvent).toHaveBeenCalledWith('connector_installed', {
      agent_type: 'codex',
      target: 'remote',
      outcome: 'failure',
      failure_reason: 'error',
      duration_ms: aDurationMs,
    });
  });

  it('says the plugin was removed when the channel drops before the re-add', async () => {
    mocks.exec.mockImplementation(dropsOn(`plugin add ${CODEX_REF}`));

    const service = await getRemoteSwitchSetupService(SSH_HOST);
    const result = await service.update('codex', 'user');

    expect(calls().slice(-2)).toEqual([`plugin remove ${CODEX_REF}`, `plugin add ${CODEX_REF}`]);
    expect(result).toEqual({
      success: false,
      message:
        'Update failed: the plugin was removed, then the connection to the host dropped before it could be reinstalled. Reconnect and install it again for this host.',
    });
    expect(mocks.trackEvent).toHaveBeenCalledWith('connector_updated', {
      agent_type: 'codex',
      target: 'remote',
      outcome: 'failure',
      was_reinstall: true,
      trigger: 'user',
      failure_reason: 'error',
      duration_ms: aDurationMs,
    });
  });
});

/**
 * A host that simply does not have the agent installed.
 *
 * Told apart from a transport failure by the shell's own answer: 127 is "no such
 * command", which the driver already recognises well enough to keep it out of
 * the warning log. Every command a marketplace-driven connector runs goes
 * through that binary, so without a code of its own the whole condition lands
 * under whichever verb ran first — `marketplace_failed` on an install, which
 * reads as a broken plugin source on a host whose only problem is that nobody
 * installed the agent.
 */
describe('RemoteSwitchSetupService when the agent CLI is not on the host', () => {
  beforeEach(() => {
    mocks.resolveCommandPath.mockResolvedValue(null);
    mocks.exec.mockImplementation(() =>
      Promise.reject(Object.assign(new Error('codex: command not found'), { code: 127 }))
    );
  });

  it('says so on install', async () => {
    const service = await getRemoteSwitchSetupService(SSH_HOST);
    await service.install('codex');

    expect(mocks.trackEvent).toHaveBeenCalledWith('connector_installed', {
      agent_type: 'codex',
      target: 'remote',
      outcome: 'failure',
      failure_reason: 'host_cli_missing',
      duration_ms: aDurationMs,
    });
  });

  it('says so on update', async () => {
    const service = await getRemoteSwitchSetupService(SSH_HOST);
    await service.update('codex', 'user');

    expect(mocks.trackEvent).toHaveBeenCalledWith('connector_updated', {
      agent_type: 'codex',
      target: 'remote',
      outcome: 'failure',
      // Nothing was removed, because nothing could run at all.
      was_reinstall: false,
      trigger: 'user',
      failure_reason: 'host_cli_missing',
      duration_ms: aDurationMs,
    });
  });
});

describe('RemoteSwitchSetupService.install', () => {
  it('installs the plugin and reports success', async () => {
    mocks.exec.mockImplementation(codexExecImpl('sandbox-quantum/switch'));

    const service = await getRemoteSwitchSetupService(SSH_HOST);
    const result = await service.install('codex');

    expect(result.success).toBe(true);
    expect(calls()).toContain(`plugin add ${CODEX_REF}`);
    expect(mocks.trackEvent).toHaveBeenCalledWith('connector_installed', {
      agent_type: 'codex',
      target: 'remote',
      outcome: 'success',
      failure_reason: 'none',
      // Elapsed wall time: a real number, but not one a test can pin.
      duration_ms: aDurationMs,
    });
  });

  it('reports failure when the install command exits non-zero', async () => {
    mocks.exec.mockImplementation((_bin: string, args: string[] = []) => {
      if (args.join(' ') === `plugin add ${CODEX_REF}`) {
        return Promise.reject(
          Object.assign(new Error('exit 1'), { code: 1, stderr: 'no write access' })
        );
      }
      return codexExecImpl('sandbox-quantum/switch')('codex', args);
    });

    const service = await getRemoteSwitchSetupService(SSH_HOST);
    const result = await service.install('codex');

    expect(result.success).toBe(false);
    expect(result.message).toBe('no write access');
    expect(mocks.trackEvent).toHaveBeenCalledWith('connector_installed', {
      agent_type: 'codex',
      target: 'remote',
      outcome: 'failure',
      failure_reason: 'install_command_failed',
      duration_ms: aDurationMs,
    });
  });

  it('reports nothing when the agent type has no Switch setup to attempt', async () => {
    mocks.getPlugin.mockReturnValue({
      metadata: { id: 'no-switch-agent' },
      capabilities: {
        switchSetup: { kind: 'none' },
        hostDependency: { binaryNames: ['nosw'] },
      },
    });

    const service = await getRemoteSwitchSetupService(SSH_HOST);
    const result = await service.install('no-switch-agent');

    expect(result).toEqual({
      success: false,
      message: 'Switch setup is not supported for this agent.',
    });
    expect(mocks.trackEvent).not.toHaveBeenCalled();
  });

  /**
   * A connector the app writes rather than installs through a CLI. The local
   * service has the same branch and the same telemetry; these are here because
   * the two are separate implementations of one behaviour, and the remote one
   * had no test of it at all.
   */
  describe('a connector the app writes itself', () => {
    const install = vi.fn();
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
      behavior: { switchSetup: { files: { install } } },
    };

    beforeEach(() => {
      mocks.getPlugin.mockReturnValue(FILES_AGENT);
    });

    it('reports the install, and writes to the host rather than running a CLI', async () => {
      install.mockResolvedValue(undefined);

      const service = await getRemoteSwitchSetupService(SSH_HOST);
      const result = await service.install('opencode');

      expect(result).toEqual({ success: true });
      expect(calls()).toEqual([]);
      expect(mocks.trackEvent).toHaveBeenCalledWith('connector_installed', {
        agent_type: 'opencode',
        target: 'remote',
        outcome: 'success',
        failure_reason: 'none',
        duration_ms: aDurationMs,
      });
    });

    it('reports its failure', async () => {
      install.mockRejectedValue(new Error('permission denied'));

      const service = await getRemoteSwitchSetupService(SSH_HOST);
      const result = await service.install('opencode');

      expect(result.success).toBe(false);
      expect(mocks.trackEvent).toHaveBeenCalledWith('connector_installed', {
        agent_type: 'opencode',
        target: 'remote',
        outcome: 'failure',
        failure_reason: 'files_write_failed',
        duration_ms: aDurationMs,
      });
    });

    it('still answers, and still reports, when the connector implements nothing', async () => {
      // A plugin can declare a files connector and supply no behaviour for it.
      // The user asked for an install: they get a failure, not a rejected
      // promise reaching the UI as a stack trace with nothing recorded.
      mocks.getPlugin.mockReturnValue({
        ...FILES_AGENT,
        behavior: { switchSetup: {} },
      });

      const service = await getRemoteSwitchSetupService(SSH_HOST);
      const result = await service.install('opencode');

      expect(result.success).toBe(false);
      // Its own code, not `files_write_failed`: a fault in the plugin rather
      // than on the host, and the two would otherwise be one number.
      expect(mocks.trackEvent).toHaveBeenCalledWith('connector_installed', {
        agent_type: 'opencode',
        target: 'remote',
        outcome: 'failure',
        failure_reason: 'files_unimplemented',
        duration_ms: aDurationMs,
      });
    });
  });
});

describe('RemoteSwitchSetupService.checkForUpdates', () => {
  it('leaves a marketplace already pointing at the expected source alone', async () => {
    mocks.exec.mockImplementation(codexExecImpl('sandbox-quantum/switch'));

    const service = await getRemoteSwitchSetupService(SSH_HOST);
    const status = await service.checkForUpdates('codex');

    expect(status.refreshError).toBeNull();
    expect(calls()).not.toContain('plugin marketplace remove switch-plugins');
    expect(calls()).toContain('plugin marketplace upgrade switch-plugins');
  });

  it('re-points a same-named marketplace registered against a stale source', async () => {
    mocks.exec.mockImplementation(codexExecImpl('sandbox-quantum/switch-legacy'));

    const service = await getRemoteSwitchSetupService(SSH_HOST);
    const status = await service.checkForUpdates('codex');

    expect(status.refreshError).toBeNull();
    expect(calls()).toContain('plugin marketplace remove switch-plugins');
    expect(calls()).toContain('plugin marketplace add sandbox-quantum/switch');
  });
});

/**
 * A broken pipe is not an answer about the connector.
 *
 * Every other failure in this driver folds into a `ConnectorRunResult`, and a
 * status read parses the empty stdout as "no plugin installed" — so a channel
 * dying mid-fan-out would render in the picker as "Its Switch connector is not
 * installed on <host>", with an Install button, for a read that never happened.
 * Reporting `refreshError` only helps if the driver raises rather than
 * inventing an empty plugin list.
 */
describe('RemoteSwitchSetupService when the transport dies', () => {
  function transportFailure() {
    return () => Promise.reject(new TransportError('SSH transport failure: not available'));
  }

  it('does not report a dead channel as a connector that is not installed', async () => {
    mocks.getPlugin.mockReturnValue(CLAUDE_AGENT);
    mocks.resolveCommandPath.mockResolvedValue('/usr/bin/claude');
    mocks.exec.mockImplementation(transportFailure());

    const service = await getRemoteSwitchSetupService(SSH_HOST);

    await expect(service.getStatus('claude')).rejects.toBeInstanceOf(TransportError);
  });

  it('still reads a shell that answered 127 as the connector being absent', async () => {
    // The distinction the re-raise has to preserve: a host without Codex is a
    // normal host, and exit 127 is that host answering — not the pipe failing.
    mocks.getPlugin.mockReturnValue(CODEX_AGENT);
    mocks.resolveCommandPath.mockResolvedValue('/usr/bin/codex');
    mocks.exec.mockImplementation(() =>
      Promise.reject(Object.assign(new Error('codex: command not found'), { code: 127 }))
    );

    const service = await getRemoteSwitchSetupService(SSH_HOST);
    const status = await service.getStatus('codex');

    expect(status).toMatchObject({ supported: true, installed: false, refreshError: null });
  });

  it('turns the raise into a row that says why, rather than dropping it', async () => {
    mocks.listPlugins.mockReturnValue([CLAUDE_AGENT]);
    mocks.getPlugin.mockReturnValue(CLAUDE_AGENT);
    mocks.resolveCommandPath.mockResolvedValue('/usr/bin/claude');
    mocks.exec.mockImplementation(transportFailure());

    const service = await getRemoteSwitchSetupService(SSH_HOST);
    const [status] = await service.listAgentTypeStatuses();

    expect(status).toMatchObject({ agentId: 'claude', supported: true, installed: false });
    expect(status!.refreshError).toMatch(/transport failure/i);
  });
});
