import type { DependencyDescriptor } from '@switch-console/core/deps/runtime';
import { pickInstallOption } from '@switch-console/core/deps/runtime';
import { describe, expect, it } from 'vitest';
import { plugin } from './index';

const hostDependency = plugin.capabilities.hostDependency;
// `pickInstallOption` reads only `installCommands`; the registry fills the rest.
const descriptor: DependencyDescriptor = {
  ...hostDependency,
  name: 'Codex',
  category: 'agent',
  commands: hostDependency.binaryNames,
};

describe('codex hostDependency', () => {
  it('recommends the ChatGPT installer on Windows, not global npm', () => {
    const picked = pickInstallOption(descriptor, 'windows');
    expect(picked?.method).toBe('powershell');
    expect(picked?.command).toContain('chatgpt.com/codex/install.ps1');
  });

  it('leaves npm available on Windows but unflagged', () => {
    const windows = hostDependency.installCommands.windows ?? [];
    expect(windows.filter((option) => option.recommended)).toHaveLength(1);
    const npm = windows.find((option) => option.method === 'npm');
    expect(npm?.recommended).toBeUndefined();
  });

  it('keeps npm recommended on macOS and Linux', () => {
    expect(pickInstallOption(descriptor, 'macos')?.method).toBe('npm');
    expect(pickInstallOption(descriptor, 'linux')?.method).toBe('npm');
  });

  it('gives every install option an uninstallCommand, since uninstall is package-manager', () => {
    expect(hostDependency.uninstall).toEqual({ kind: 'package-manager' });
    for (const [platform, options] of Object.entries(hostDependency.installCommands)) {
      for (const option of options) {
        expect(option.uninstallCommand, `${platform}/${option.method}`).toBeTruthy();
      }
    }
  });

  it('removes only what install.ps1 created, and interpolates in neither shell', () => {
    const uninstall = pickInstallOption(descriptor, 'windows')?.uninstallCommand ?? '';
    expect(uninstall).toContain("'Programs\\OpenAI\\Codex'");
    expect(uninstall).toContain("'.codex\\packages\\standalone'");
    expect(uninstall).not.toMatch(/[$%]/);
  });
});
