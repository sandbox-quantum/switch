import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Configuration } from 'electron-builder';
import { describe, expect, it } from 'vitest';

// Imported through a variable so the type checker leaves the config alone: it
// imports with a `.ts` extension, written for electron-builder's bare Node.
const configPath = '../electron-builder.config.ts';
const { default: config } = (await import(configPath)) as { default: Configuration };

const entitlements = (file: string) => readFileSync(resolve(__dirname, '..', file), 'utf8');

describe('electron-builder config', () => {
  it('sets every Electron fuse, hardened where Console allows', () => {
    expect(config.electronFuses).toEqual({
      enableCookieEncryption: true,
      // The ELECTRON_RUN_AS_NODE self-spawns need it until they have a runtime of their own.
      runAsNode: true,
      enableNodeCliInspectArguments: false,
      // Also governs NODE_EXTRA_CA_CERTS; see the config.
      enableNodeOptionsEnvironmentVariable: true,
      onlyLoadAppFromAsar: true,
      enableEmbeddedAsarIntegrityValidation: true,
      grantFileProtocolExtraPrivileges: false,
      loadBrowserProcessSpecificV8Snapshot: false,
    });
  });

  it('keeps library validation for the app itself in a Developer ID build', () => {
    const developerId = entitlements('build/entitlements.mac.developer-id.plist');
    expect(developerId).not.toContain('disable-library-validation');
    expect(developerId).toContain('com.apple.security.cs.allow-jit');
    // The ad-hoc fallback has no team for nested modules to match.
    expect(entitlements('build/entitlements.mac.plist')).toContain(
      'com.apple.security.cs.disable-library-validation'
    );
  });
});
