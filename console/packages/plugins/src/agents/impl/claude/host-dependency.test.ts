import type { DependencyDescriptor } from '@switch-console/core/deps/runtime';
import { pickInstallOption } from '@switch-console/core/deps/runtime';
import { describe, expect, it } from 'vitest';
import { plugin } from './index';

const hostDependency = plugin.capabilities.hostDependency;
const descriptor: DependencyDescriptor = {
  ...hostDependency,
  name: 'Claude Code',
  category: 'agent',
  commands: hostDependency.binaryNames,
};

describe('claude hostDependency on Windows', () => {
  it("runs Anthropic's install.ps1 through PowerShell, then puts ~\\.local\\bin on PATH", () => {
    const picked = pickInstallOption(descriptor, 'windows');
    expect(picked?.method).toBe('powershell');
    expect(picked?.command).toMatch(
      /^powershell -ExecutionPolicy ByPass -c "irm https:\/\/claude\.ai\/install\.ps1 \| iex; /
    );
    expect(picked?.command).toContain("'.local', 'bin'");
  });

  // The install runner's shell may be cmd.exe, Windows PowerShell or Git Bash:
  // `&&` does not parse in Windows PowerShell 5.1, and `$`/`%` would be expanded
  // by one shell or another before `powershell -c` saw them.
  it('is a single command that every Windows shell passes through unchanged', () => {
    const command = pickInstallOption(descriptor, 'windows')?.command ?? '';
    expect(command).not.toContain('&&');
    expect(command).not.toMatch(/[$%]/);
    expect(command.slice(command.indexOf('"') + 1, -1)).not.toContain('"');
  });
});
