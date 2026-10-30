import type { CommandContext } from '@switch-console/core/agents/plugins';
import { describe, expect, it } from 'vitest';
import { pluginRegistry } from '../registry';

describe('pluginRegistry', () => {
  it('each entry has required string fields', () => {
    for (const d of pluginRegistry.getAll()) {
      expect(typeof d.metadata.id).toBe('string');
      expect(d.metadata.id.length).toBeGreaterThan(0);
      expect(typeof d.metadata.name).toBe('string');
      expect(typeof d.metadata.description).toBe('string');
      expect(typeof d.metadata.websiteUrl).toBe('string');
    }
  });

  it('each entry passes validate() with no errors', () => {
    for (const d of pluginRegistry.getAll()) {
      const errors = d.validate();
      expect(errors, `${d.metadata.id} validate() errors: ${JSON.stringify(errors)}`).toHaveLength(
        0
      );
    }
  });

  it('capabilities contain no function values at top level', () => {
    for (const d of pluginRegistry.getAll()) {
      for (const v of Object.values(d.capabilities as Record<string, unknown>)) {
        expect(typeof v).not.toBe('function');
      }
    }
  });

  it('each entry has required capabilities', () => {
    for (const d of pluginRegistry.getAll()) {
      const { capabilities } = d;
      expect(capabilities.hostDependency).toBeDefined();
      expect(capabilities.mcp).toBeDefined();
      expect(capabilities.plugins).toBeDefined();
      expect(['supported', 'none']).toContain(capabilities.autoApprove.kind);
      expect(['resumable', 'stateless']).toContain(capabilities.sessions.kind);
    }
  });

  it('each entry has hostDependency.updates with valid kind', () => {
    for (const d of pluginRegistry.getAll()) {
      expect(d.capabilities.hostDependency.updates).toBeDefined();
      expect(['supported', 'none']).toContain(d.capabilities.hostDependency.updates.kind);
    }
  });

  it('supported updates have valid releaseSource and update strategy', () => {
    for (const d of pluginRegistry.getAll()) {
      if (d.capabilities.hostDependency.updates.kind !== 'supported') continue;
      const { releaseSource, update } = d.capabilities.hostDependency.updates;
      expect(['npm', 'github', 'none']).toContain(releaseSource.kind);
      expect(['package-manager', 'cli', 'auto', 'none']).toContain(update.kind);
    }
  });

  it('all binaryNames are non-empty strings', () => {
    for (const d of pluginRegistry.getAll()) {
      expect(d.capabilities.hostDependency.binaryNames.length).toBeGreaterThan(0);
      for (const bin of d.capabilities.hostDependency.binaryNames) {
        expect(typeof bin).toBe('string');
        expect(bin.length).toBeGreaterThan(0);
      }
    }
  });

  it('each defined platform installCommands entry is a non-empty array of valid InstallOptions', () => {
    const validMethods = [
      'installer-macos',
      'installer-windows',
      'installer-linux',
      'homebrew',
      'winget',
      'powershell',
      'npm',
      'apt',
      'curl',
      'pip',
      'cargo',
      'other',
    ];
    for (const d of pluginRegistry.getAll()) {
      const { installCommands } = d.capabilities.hostDependency;
      for (const [platform, options] of Object.entries(installCommands)) {
        expect(Array.isArray(options), `${d.metadata.id}.${platform} should be an array`).toBe(
          true
        );
        expect(
          options!.length,
          `${d.metadata.id}.${platform} array should be non-empty`
        ).toBeGreaterThan(0);
        for (const opt of options!) {
          expect(
            typeof opt.command,
            `${d.metadata.id}.${platform} command should be a string`
          ).toBe('string');
          expect(
            opt.command.length,
            `${d.metadata.id}.${platform} command should be non-empty`
          ).toBeGreaterThan(0);
          expect(validMethods, `${d.metadata.id}.${platform} method should be valid`).toContain(
            opt.method
          );
        }
      }
    }
  });

  it('each entry has an icon asset with at least one variant', () => {
    for (const d of pluginRegistry.getAll()) {
      expect(d.assets.icon).toBeDefined();
      expect(d.assets.icon.variants.length).toBeGreaterThan(0);
      for (const v of d.assets.icon.variants) {
        expect(typeof v.light).toBe('string');
        expect(v.light.length).toBeGreaterThan(0);
      }
    }
  });

  it('each entry declares a repo-agents descriptor; only supporting types carry a behavior', () => {
    for (const d of pluginRegistry.getAll()) {
      const descriptor = d.capabilities.repoAgents;
      expect(['definitions', 'none'], `${d.metadata.id}.repoAgents.kind`).toContain(
        descriptor.kind
      );
      // A 'none' provider must not ship a repo-agents behavior; a supporting one must.
      if (descriptor.kind === 'none') {
        expect(d.behavior.repoAgents, `${d.metadata.id} should have no repo-agents behavior`).toBe(
          undefined
        );
      } else {
        expect(
          typeof d.behavior.repoAgents?.launchArgs,
          `${d.metadata.id} should ship a repo-agents behavior`
        ).toBe('function');
      }
    }
  });

  it('claude is the repo-agents-supporting provider', () => {
    expect(pluginRegistry.get('claude')!.capabilities.repoAgents.kind).toBe('definitions');
    expect(pluginRegistry.get('codex')!.capabilities.repoAgents.kind).toBe('none');
  });

  it('each entry has a behavior.prompt.buildCommand function', () => {
    for (const p of pluginRegistry.getAll()) {
      expect(typeof p.behavior.prompt?.buildCommand).toBe('function');
    }
  });

  it('updates Mistral Vibe with uv instead of reinstalling it on Windows', () => {
    expect(
      pluginRegistry.get('mistral-vibe')!.capabilities.hostDependency.installCommands.windows
    ).toContainEqual(
      expect.objectContaining({ updateCommand: 'uv tool install --upgrade mistral-vibe' })
    );
  });
});

describe('permission flags', () => {
  const base: CommandContext = {
    cli: 'agent-cli',
    autoApprove: false,
    autoMode: false,
    isResuming: false,
    sessionId: 'switch-console-session',
    model: '',
  };
  const build = (id: string, ctx: Partial<CommandContext>) =>
    pluginRegistry.get(id)!.behavior.prompt!.buildCommand({ ...base, ...ctx });

  it.each([
    ['claude', ['--permission-mode', 'auto'], ['--dangerously-skip-permissions']],
    [
      'codex',
      ['-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"'],
      ['-c', 'approval_policy="never"'],
    ],
    ['opencode', ['--auto'], []],
    ['cursor', [], ['-f', '--approve-mcps']],
  ])('%s: auto mode, bypass, and bypass winning over auto mode', (id, autoFlags, bypassFlags) => {
    const none = build(id, {}).args;
    const auto = build(id, { autoMode: true }).args;
    const bypass = build(id, { autoApprove: true }).args;
    const both = build(id, { autoApprove: true, autoMode: true }).args;

    expect(auto).toEqual([...none, ...autoFlags]);
    expect(bypass).toEqual([...none, ...bypassFlags]);
    expect(both).toEqual(bypass);
  });

  it('opencode bypasses through its permission environment and never in auto mode', () => {
    expect(build('opencode', { autoApprove: true }).env).toEqual({
      OPENCODE_PERMISSION: '{"*":"allow"}',
    });
    expect(build('opencode', { autoMode: true }).env).toEqual({});
  });
});
