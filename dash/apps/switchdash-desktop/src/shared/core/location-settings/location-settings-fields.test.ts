import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESERVE_PATTERNS, type LocationSettings } from './location-settings';
import { hasConfiguredShareableLocationSettings } from './location-settings-fields';

describe('hasConfiguredShareableLocationSettings', () => {
  it('does not treat seeded default preserve patterns as configured settings', () => {
    expect(
      hasConfiguredShareableLocationSettings({
        preservePatterns: [...DEFAULT_PRESERVE_PATTERNS],
      })
    ).toBe(false);
  });

  it('does not treat reordered default preserve patterns as configured settings', () => {
    expect(
      hasConfiguredShareableLocationSettings({
        preservePatterns: [...DEFAULT_PRESERVE_PATTERNS].reverse(),
      })
    ).toBe(false);
  });

  it('treats non-default preserve patterns as configured settings', () => {
    expect(
      hasConfiguredShareableLocationSettings({
        preservePatterns: ['.env*'],
      })
    ).toBe(true);
  });

  it('treats scripts and shell setup as configured settings', () => {
    const settings: LocationSettings = {
      preservePatterns: [...DEFAULT_PRESERVE_PATTERNS],
      shellSetup: 'nvm use',
      scripts: {
        setup: 'npm install',
      },
    };

    expect(hasConfiguredShareableLocationSettings(settings)).toBe(true);
  });
});
