import { ownProvenance } from '@switch-console/core/deps/runtime';
import { describe, expect, it } from 'vitest';
import { plugin } from './index';

const hostDependency = plugin.capabilities.hostDependency;

function firstOption(platform: 'macos' | 'linux' | 'windows') {
  const option = hostDependency.installCommands?.[platform]?.[0];
  if (!option) throw new Error(`no install option declared for ${platform}`);
  return option;
}

describe('opencode host dependency', () => {
  // npm's default global prefix on Linux is a system directory, so a plain
  // `npm install -g` needs root. Remote agent users generally do not have it,
  // and the install dies with EACCES partway through host setup.
  it('installs into the user prefix on Linux', () => {
    const option = firstOption('linux');
    expect(option.command).toContain('--prefix "$HOME/.local"');
    expect(option.uninstallCommand).toContain('--prefix "$HOME/.local"');
    expect(option.recommended).toBe(true);
  });

  // `npm root -g` names the system prefix, so only the option itself can say
  // that a copy under ~/.local is its own and can be upgraded.
  it('recognises its own Linux install, for either package', () => {
    const unknown = { kind: 'unknown', confidence: 'inferred' } as const;
    for (const realpath of [
      '/home/ada/.local/lib/node_modules/opencode-ai/bin/opencode.exe',
      '/home/ada/.local/lib/node_modules/@opencode/cli/bin/opencode',
    ]) {
      expect(ownProvenance(unknown, hostDependency, 'linux', realpath, '/home/ada')).toEqual({
        kind: 'npm',
        confidence: 'confirmed',
      });
    }
    expect(
      ownProvenance(unknown, hostDependency, 'linux', '/usr/local/bin/opencode', '/home/ada')
    ).toEqual(unknown);
  });

  it('installs OpenCode 2 from npm on macOS and Linux', () => {
    for (const platform of ['macos', 'linux'] as const) {
      expect(firstOption(platform).command).toMatch(/@opencode\/cli$/);
      expect(firstOption(platform).command).not.toContain('opencode-ai');
    }
  });

  // macOS npm prefixes are user-writable already, and moving them would
  // strand anyone who installed before this.
  it('leaves the macOS prefix alone', () => {
    expect(firstOption('macos').command).not.toContain('--prefix');
  });

  it("uninstalls both @opencode/cli and OpenCode 1's opencode-ai", () => {
    for (const platform of ['macos', 'linux'] as const) {
      const cmd = firstOption(platform).uninstallCommand ?? '';
      expect(cmd).toContain('@opencode/cli');
      expect(cmd).toContain('opencode-ai');
    }
  });

  // A fresh Windows has no Node, so no npm.
  // GitHub's latest release can be a 1.x one, which the upgrade would then
  // install again; npm's latest `@opencode/cli` is always 2.x.
  it('installs the release of the latest npm version on Windows, without npm, and offers npm after it', () => {
    const [release, npm] = hostDependency.installCommands?.windows ?? [];
    expect(release?.recommended).toBe(true);
    expect(release?.command).toContain(
      "/releases/download/v' + (Invoke-RestMethod 'https://registry.npmjs.org/@opencode/cli/latest').version + '/"
    );
    expect(release?.command).not.toContain('/releases/latest/');
    expect(release?.command).toContain('opencode-windows-x64.zip');
    expect(release?.command).not.toMatch(/[$%]/);
    expect(release?.command.slice(release.command.indexOf('"') + 1, -1)).not.toContain('"');
    expect(release?.uninstallCommand).toContain("'.opencode', 'bin'");
    expect(npm?.command).toBe('npm install -g @opencode/cli');
    expect(npm?.recommended).toBeUndefined();
  });

  it('probes the opencode binary', () => {
    expect(hostDependency.binaryNames).toEqual(['opencode']);
  });

  // npm refuses to install @opencode/cli over opencode-ai, and the reverse
  // (both own `opencode`), so updating 1.x has to remove it first and, if
  // OpenCode 2 then fails to install, remove what of it arrived and put the
  // same 1.x back.
  it('upgrades 1.x by replacing opencode-ai, restoring it on failure', () => {
    const windowsNpm = hostDependency.installCommands?.windows?.[1];
    for (const migration of [
      firstOption('macos').lineMigration,
      firstOption('linux').lineMigration,
      windowsNpm?.lineMigration,
    ]) {
      expect(migration?.below).toBe('2.0.0');
      expect(migration?.removeCommand).toContain('npm uninstall -g');
      expect(migration?.removeCommand).toContain('opencode-ai');
      expect(migration?.removeCommand).not.toContain('@opencode/cli');
      expect(migration?.restoreCommand).toMatch(
        /npm uninstall -g (--prefix "\$HOME\/\.local" )?@opencode\/cli && npm install -g .*opencode-ai@\{version\}/
      );
    }
    expect(firstOption('linux').lineMigration?.restoreCommand).toBe(
      'npm uninstall -g --prefix "$HOME/.local" @opencode/cli && npm install -g --prefix "$HOME/.local" opencode-ai@{version}'
    );
    expect(windowsNpm?.lineMigration?.restoreCommand).toBe(
      'cmd /c "npm uninstall -g @opencode/cli && npm install -g opencode-ai@{version}"'
    );
  });

  // The release zip holds only opencode.exe, so a 1.x one is replaced by
  // unpacking the new release, and put back by unpacking the one it replaced.
  it('upgrades a 1.x release on Windows, restoring the same release on failure', () => {
    const release = firstOption('windows');
    const migration = release.lineMigration;
    expect(migration?.below).toBe('2.0.0');
    expect(migration?.removeCommand).toBe(release.uninstallCommand);
    expect(migration?.restoreCommand).toContain("/releases/download/v' + '{version}' + '/");
    expect(migration?.restoreCommand).not.toMatch(/[$%]/);
  });

  // Windows cannot delete opencode.exe while it runs, so the upgrade checks first.
  it('checks for a running OpenCode before upgrading on Windows only', () => {
    for (const option of hostDependency.installCommands?.windows ?? []) {
      const precheck = option.lineMigration?.precheck;
      expect(precheck?.command).toContain('Get-Process -Name opencode');
      expect(precheck?.command).not.toMatch(/[$%]/);
      expect(precheck?.blockedMessage).toContain('Nothing was changed.');
    }
    expect(firstOption('macos').lineMigration?.precheck).toBeUndefined();
    expect(firstOption('linux').lineMigration?.precheck).toBeUndefined();
  });
});
