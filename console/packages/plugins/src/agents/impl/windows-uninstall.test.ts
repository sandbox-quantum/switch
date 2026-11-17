import { ownProvenance } from '@switch-console/core/deps/runtime';
import { describe, expect, it } from 'vitest';
import { plugin as claude } from './claude/index';
import { plugin as codex } from './codex/index';
import { plugin as opencode } from './opencode/index';

const home = 'C:\\Users\\ada';
const unknown = { kind: 'unknown' as const, confidence: 'inferred' as const };

describe('Windows installs Switch Console can manage afterwards', () => {
  it.each([
    ['claude', claude, `${home}\\.local\\bin\\claude.exe`],
    ['codex', codex, `${home}\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe`],
    ['opencode', opencode, `${home}\\.opencode\\bin\\opencode.exe`],
  ] as const)('%s: its own install claims where it installs, and can uninstall it', (_, p, at) => {
    const dependency = p.capabilities.hostDependency;
    const { kind } = ownProvenance(unknown, dependency, 'windows', at, home);
    const own = dependency.installCommands?.windows?.find((option) => option.method === kind);
    expect(own?.uninstallCommand).toMatch(/^powershell /);
    expect(own?.uninstallCommand).not.toMatch(/[$%]/);
  });

  it.each([
    ['claude', claude],
    ['opencode', opencode],
  ] as const)(
    '%s: an uninstall that cannot delete says so, and only a missing path is passed over',
    (_, p) => {
      const command =
        p.capabilities.hostDependency.installCommands?.windows?.find((o) => o.uninstallCommand)
          ?.uninstallCommand ?? '';
      expect(command).toContain('-ErrorAction Stop');
      expect(command).toContain('Test-Path');
      expect(command).not.toContain('SilentlyContinue');
    }
  );

  it('Claude Code is removed by deleting its files: it has no uninstall command', () => {
    for (const platform of ['macos', 'linux', 'windows'] as const) {
      for (const option of claude.capabilities.hostDependency.installCommands?.[platform] ?? []) {
        expect(option.uninstallCommand ?? '').not.toContain('claude uninstall');
      }
    }
  });
});
