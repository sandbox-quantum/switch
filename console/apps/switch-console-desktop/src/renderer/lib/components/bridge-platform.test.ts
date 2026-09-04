import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SWITCH_DOCS_MESSAGING_APPS_URL } from '@shared/urls';
import { hasBridgeIcon } from './bridge-icon';
import { bridgePlatformLabel, bridgeSetupDocsUrl } from './bridge-platform';

/** Every bridge type switch-core registers today (`main.py` register_adapter). */
const BRIDGE_TYPES = ['slack', 'mattermost', 'discord', 'teams', 'telegram'];

const BRIDGE_ICON_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../assets/images/bridges'
);

describe('bridgePlatformLabel', () => {
  it('names each platform the way its own docs do', () => {
    expect(bridgePlatformLabel('slack')).toBe('Slack');
    expect(bridgePlatformLabel('mattermost')).toBe('Mattermost');
    expect(bridgePlatformLabel('discord')).toBe('Discord');
    expect(bridgePlatformLabel('teams')).toBe('Microsoft Teams');
    expect(bridgePlatformLabel('telegram')).toBe('Telegram');
  });

  it('falls back to the raw key for a type this build does not know', () => {
    // A newer switch-core can register a bridge type this app has never heard
    // of. Showing the slug is wrong-looking but still identifies it.
    expect(bridgePlatformLabel('zulip')).toBe('zulip');
  });

  it('has a generic word for an unbridged room', () => {
    expect(bridgePlatformLabel(null)).toBe('messaging app');
    expect(bridgePlatformLabel(undefined)).toBe('messaging app');
  });
});

describe('bridgeSetupDocsUrl', () => {
  it('points at the per-platform page on the documentation site', () => {
    expect(bridgeSetupDocsUrl('slack')).toBe(`${SWITCH_DOCS_MESSAGING_APPS_URL}/slack`);
    // `teams` is published under its full name, so the bridge key is not a
    // usable slug — the one mapping in here that is not the identity.
    expect(bridgeSetupDocsUrl('teams')).toBe(`${SWITCH_DOCS_MESSAGING_APPS_URL}/microsoft-teams`);
  });

  it('falls back to the index rather than a dead link', () => {
    expect(bridgeSetupDocsUrl('zulip')).toBe(SWITCH_DOCS_MESSAGING_APPS_URL);
  });

  it.each(BRIDGE_TYPES)('%s has its own page rather than the index', (type) => {
    // Falling back is right for a bridge type this build has never heard of,
    // but silently doing it for one we ship is a mapping we forgot to add.
    const url = bridgeSetupDocsUrl(type);
    expect(url).not.toBe(SWITCH_DOCS_MESSAGING_APPS_URL);
    expect(url.startsWith(`${SWITCH_DOCS_MESSAGING_APPS_URL}/`)).toBe(true);
  });
});

describe('bridge brand icons', () => {
  it.each(BRIDGE_TYPES)('%s has an icon', (type) => {
    // `bridge-icon.tsx` keys its glob on the filename, and several call sites
    // gate behaviour on an icon existing — a room's "Open in <app>" button is
    // hidden without one, even when the deeplink resolves. So a missing file
    // is a functional gap, not just a cosmetic one (CHOO-1784).
    expect(existsSync(join(BRIDGE_ICON_DIR, `${type}.svg`))).toBe(true);
  });

  it.each(BRIDGE_TYPES)('the icon loader actually resolves %s', (type) => {
    // `existsSync` above only proves the file is on disk. The app reads these
    // through a Vite glob keyed on filename, so an icon in the wrong directory,
    // or one the raw loader hands back in an unexpected shape, would pass the
    // check above and still leave the button hidden at runtime — which is the
    // failure this pair is here to prevent.
    expect(hasBridgeIcon(type)).toBe(true);
  });

  it('reports no icon for a type this build does not bundle', () => {
    expect(hasBridgeIcon('zulip')).toBe(false);
    expect(hasBridgeIcon(null)).toBe(false);
    expect(hasBridgeIcon(undefined)).toBe(false);
  });

  it('has a label for every bundled icon', () => {
    // The reverse direction: an icon with no label would render next to a raw
    // slug in the picker.
    const bundled = readdirSync(BRIDGE_ICON_DIR)
      .filter((f) => f.endsWith('.svg'))
      .map((f) => f.replace(/\.svg$/, ''));

    for (const type of bundled) {
      expect(bridgePlatformLabel(type)).not.toBe(type);
    }
  });
});
