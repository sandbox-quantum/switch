import type { WebPreferences } from 'electron';
import { describe, expect, it } from 'vitest';
import { mattermostPartition } from '@shared/core/switch-rooms/room-embed';
import { constrainGuest } from './guest-webview';

const PRELOAD = '/app/out/preload/mattermost-guest.mjs';
const ROOM_VIEW = {
  src: 'https://chat.example.com/team/channels/room',
  partition: mattermostPartition('srv-1'),
};
/** What the main process prepared: srv-1's room view, on its Mattermost. */
const prepared = (partition: string) =>
  partition === ROOM_VIEW.partition ? 'https://chat.example.com' : undefined;

describe('constrainGuest', () => {
  it('lets the room view attach, as room-embed-layer asks for it', () => {
    const prefs: WebPreferences = {};
    expect(
      constrainGuest(prefs, { ...ROOM_VIEW, allowpopups: 'true' }, PRELOAD, false, prepared)
    ).toBeNull();
    expect(prefs).toMatchObject({
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    });
  });

  it('overrides whatever widening the markup asked for', () => {
    const prefs: WebPreferences = {
      preload: 'file:///tmp/evil-preload.js',
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      experimentalFeatures: true,
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      contextIsolation: false,
      webviewTag: true,
      devTools: true,
      enableBlinkFeatures: 'SomeFeature',
      disableBlinkFeatures: 'OtherFeature',
    };

    constrainGuest(prefs, ROOM_VIEW, PRELOAD, false, prepared);

    expect(prefs).toEqual({
      preload: PRELOAD,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      webviewTag: false,
      devTools: false,
    });
  });

  it.each([
    ['a file', { ...ROOM_VIEW, src: 'file:///etc/passwd' }],
    ['a custom scheme', { ...ROOM_VIEW, src: 'some-app://run' }],
    ['no source', { partition: ROOM_VIEW.partition }],
    ['an unparseable source', { ...ROOM_VIEW, src: 'not a url' }],
  ])('refuses %s as a source', (_case, params) => {
    expect(constrainGuest({}, params, PRELOAD, false, prepared)).toBe(
      'its source is not an http(s) page'
    );
  });

  it.each([
    ['the app’s own session', { src: ROOM_VIEW.src }],
    ['an empty partition', { ...ROOM_VIEW, partition: '' }],
    ['another persistent partition', { ...ROOM_VIEW, partition: 'persist:switch-gateway:srv-1' }],
    [
      'a room view partition never prepared',
      { ...ROOM_VIEW, partition: mattermostPartition('srv-2') },
    ],
  ])('refuses %s', (_case, params) => {
    expect(constrainGuest({}, params, PRELOAD, false, prepared)).toBe(
      'its partition is not one prepared for a room view'
    );
  });

  it('refuses a prepared partition loading another site', () => {
    expect(
      constrainGuest(
        {},
        { ...ROOM_VIEW, src: 'https://elsewhere.example.com/' },
        PRELOAD,
        false,
        prepared
      )
    ).toBe('its source is not the Mattermost its partition was prepared for');
  });
});
