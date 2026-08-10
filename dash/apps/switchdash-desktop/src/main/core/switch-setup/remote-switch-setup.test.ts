import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  resolveCommandPath: vi.fn(),
  getPlugin: vi.fn(),
  listPlugins: vi.fn(),
  ensureSshConnected: vi.fn(),
}));

vi.mock('@main/core/execution-context/ssh-execution-context', () => ({
  SshExecutionContext: class {
    exec = mocks.exec;
  },
}));

vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({
  ensureSshConnected: mocks.ensureSshConnected,
}));

vi.mock('@switchdash/core/deps/runtime', () => ({
  resolveCommandPath: mocks.resolveCommandPath,
}));

vi.mock('../providers/plugin-registry', () => ({
  getPlugin: mocks.getPlugin,
  listPlugins: mocks.listPlugins,
}));

vi.mock('@main/lib/logger', () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

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

  it('does not read manifests when the CLI already advertises versions', async () => {
    // Claude Code reports them in `marketplace list --json`, so the fallback is
    // dead weight there — two SSH round trips per status read.
    mocks.getPlugin.mockReturnValue(CLAUDE_AGENT);
    mocks.resolveCommandPath.mockResolvedValue('/usr/bin/claude');
    mocks.exec.mockImplementation(claudeExecImpl('0.1.0', '0.2.0'));

    const service = await getRemoteSwitchSetupService(SSH_HOST);
    await service.getStatus('claude');

    expect(calls()).toEqual(['plugin list --json', 'plugin marketplace list --json']);
  });
});

describe('RemoteSwitchSetupService.update', () => {
  it('repairs a stale marketplace before removing the installed plugin', async () => {
    // With no per-plugin update verb the update is destructive: a marketplace
    // still pointing at a pre-migration source would fail the re-add *after* the
    // remove succeeded, leaving the host with no connector.
    mocks.exec.mockImplementation(codexExecImpl('sandbox-quantum/switch-legacy'));

    const service = await getRemoteSwitchSetupService(SSH_HOST);
    const result = await service.update('codex');

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
    const result = await service.update('codex');

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
    const result = await service.update('codex');

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
    const result = await service.update('codex');

    expect(calls().slice(-2)).toEqual([`plugin remove ${CODEX_REF}`, `plugin add ${CODEX_REF}`]);
    expect(result).toEqual({
      success: false,
      message:
        'Update failed: the plugin was removed but could not be reinstalled. Install it again for this host.',
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
