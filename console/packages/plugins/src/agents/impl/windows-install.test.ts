import { describe, expect, it } from 'vitest';
import { CURSOR_INSTALL_WINDOWS, plugin as cursor } from './cursor';
import {
  DSH_ALLOW_SCRIPTS,
  DSH_INSTALL_VERSION,
  plugin as deepseekHarness,
} from './deepseek-harness';
import { GOOSE_INSTALL_WINDOWS, plugin as goose } from './goose';
import { KIRO_INSTALL_WINDOWS, plugin as kiro } from './kiro';
import {
  MISTRAL_VIBE_INSTALL_WINDOWS,
  MISTRAL_VIBE_UPDATE_WINDOWS,
  plugin as mistralVibe,
} from './mistral-vibe';

// CHOO-4463: each of these showed "Not found" on Windows with nothing to install.
describe.each([
  ['cursor', cursor, CURSOR_INSTALL_WINDOWS, "irm 'https://cursor.com/install?win32=true' | iex"],
  ['kiro', kiro, KIRO_INSTALL_WINDOWS, 'irm https://cli.kiro.dev/install.ps1 | iex'],
  [
    'goose',
    goose,
    GOOSE_INSTALL_WINDOWS,
    'irm https://raw.githubusercontent.com/aaif-goose/goose/main/download_cli.ps1 | iex',
  ],
  ['mistral-vibe', mistralVibe, MISTRAL_VIBE_INSTALL_WINDOWS, 'uv tool install mistral-vibe'],
] as const)('%s Windows install', (_id, plugin, command, vendorStep) => {
  const windows = plugin.capabilities.hostDependency.installCommands.windows ?? [];

  it('offers a PowerShell install on Windows', () => {
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ method: 'powershell', command });
  });

  it("runs the vendor's documented installer", () => {
    expect(command).toContain(vendorStep);
  });

  it('runs from cmd.exe and PowerShell alike', () => {
    expect(command.startsWith('powershell -ExecutionPolicy ByPass -c "')).toBe(true);
    expect(command.endsWith('"')).toBe(true);
    // One pair of double quotes: the -c argument. Anything inside uses single quotes.
    expect(command.split('"')).toHaveLength(3);
    expect(command).not.toMatch(/[$%]/);
  });

  it('keeps the macOS and Linux installs', () => {
    const { macos, linux } = plugin.capabilities.hostDependency.installCommands;
    expect(macos?.[0]?.method).toBe('curl');
    expect(linux?.[0]?.method).toBe('curl');
  });
});

describe('goose Windows install', () => {
  it('skips the interactive `goose configure`, as the shell install does', () => {
    expect(GOOSE_INSTALL_WINDOWS).toContain(
      "[Environment]::SetEnvironmentVariable('CONFIGURE', 'false', 'Process')"
    );
  });
});

describe('mistral-vibe Windows install', () => {
  it('installs uv first, as the vendor documents', () => {
    expect(MISTRAL_VIBE_INSTALL_WINDOWS).toContain('irm https://astral.sh/uv/install.ps1 | iex;');
    expect(MISTRAL_VIBE_INSTALL_WINDOWS.indexOf('install.ps1')).toBeLessThan(
      MISTRAL_VIBE_INSTALL_WINDOWS.indexOf('uv tool install')
    );
  });

  it('upgrades through uv, without `$` or `%`', () => {
    const [option] = mistralVibe.capabilities.hostDependency.installCommands.windows ?? [];
    expect(option?.updateCommand).toBe(MISTRAL_VIBE_UPDATE_WINDOWS);
    expect(MISTRAL_VIBE_UPDATE_WINDOWS).toContain('uv tool upgrade mistral-vibe');
    expect(MISTRAL_VIBE_UPDATE_WINDOWS).not.toMatch(/[$%]/);
    expect(MISTRAL_VIBE_UPDATE_WINDOWS.split('"')).toHaveLength(3);
  });
});

describe('deepseek-harness install', () => {
  const { installCommands } = deepseekHarness.capabilities.hostDependency;

  it.each(['macos', 'linux'] as const)(
    'installs from npm with its install scripts allowed on %s',
    (platform) => {
      expect(installCommands[platform]?.[0]).toMatchObject({
        method: 'npm',
        command: `npm install -g ${DSH_ALLOW_SCRIPTS} @deepseek-ai/dsh@${DSH_INSTALL_VERSION}`,
        uninstallCommand: 'npm uninstall -g @deepseek-ai/dsh',
        recommended: true,
      });
    }
  );

  it('allows the scripts its spawn helper and shell need', () => {
    for (const pkg of ['@deepseek-ai/dsh-subprocess-local', 'koffi', 'node-pty'])
      expect(DSH_ALLOW_SCRIPTS.split('=')[1]?.split(',')).toContain(pkg);
  });

  it('is not offered on Windows until a Switch session has run there', () => {
    expect(installCommands.windows).toBeUndefined();
  });
});
