import { describe, expect, it } from 'vitest';
import { plugin as claude } from './claude/index';
import { plugin as codex } from './codex/index';
import { plugin as opencode } from './opencode/index';

const windows = (p: typeof claude) => p.capabilities.hostDependency.installCommands?.windows ?? [];

describe('Windows installs Switch Console can manage afterwards', () => {
  it.each([
    ['claude', claude, 'C:\\Users\\ada\\.local\\bin\\claude.exe'],
    ['codex', codex, 'C:\\Users\\ada\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe'],
    ['opencode', opencode, 'C:\\Users\\ada\\.opencode\\bin\\opencode.exe'],
  ] as const)('%s: its own install claims where it installs, and can uninstall it', (_, p, at) => {
    const own = windows(p).find((option) =>
      option.installedAt?.some((fragment) => at.toLowerCase().includes(fragment.toLowerCase()))
    );
    expect(own?.uninstallCommand).toMatch(/^powershell /);
    expect(own?.uninstallCommand).not.toMatch(/[$%]/);
  });

  it('Claude Code is removed by deleting its files: it has no uninstall command', () => {
    for (const platform of ['macos', 'linux', 'windows'] as const) {
      for (const option of claude.capabilities.hostDependency.installCommands?.[platform] ?? []) {
        expect(option.uninstallCommand ?? '').not.toContain('claude uninstall');
      }
    }
  });
});
