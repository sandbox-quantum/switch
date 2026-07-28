import { describe, expect, it } from 'vitest';
import { channelUrlFromDeeplink, mattermostPartition, parseSetCookie } from './room-embed';

describe('parseSetCookie', () => {
  // The three cookies a real Mattermost login issues. Replaying only the first
  // left the web app rendering its login page despite a valid session.
  it('keeps MMAUTHTOKEN HttpOnly', () => {
    expect(parseSetCookie('MMAUTHTOKEN=abc123; Path=/; HttpOnly; SameSite=Lax')).toEqual({
      name: 'MMAUTHTOKEN',
      value: 'abc123',
      path: '/',
      httpOnly: true,
    });
  });

  it('leaves MMUSERID readable, since the web app reads it from document.cookie', () => {
    expect(parseSetCookie('MMUSERID=u1; Path=/; SameSite=Lax')).toEqual({
      name: 'MMUSERID',
      value: 'u1',
      path: '/',
      httpOnly: false,
    });
  });

  it('leaves MMCSRF readable', () => {
    expect(parseSetCookie('MMCSRF=tok; Path=/; SameSite=Lax')?.httpOnly).toBe(false);
  });

  it('honours an explicit Path', () => {
    expect(parseSetCookie('A=b; Path=/sub')?.path).toBe('/sub');
  });

  it('defaults Path to / when absent', () => {
    expect(parseSetCookie('A=b; HttpOnly')?.path).toBe('/');
  });

  it('matches attributes case-insensitively', () => {
    expect(parseSetCookie('A=b; path=/x; httponly')).toMatchObject({
      path: '/x',
      httpOnly: true,
    });
  });

  it('preserves a value containing =', () => {
    expect(parseSetCookie('A=b=c=; Path=/')?.value).toBe('b=c=');
  });

  it('returns null for a header with no name=value pair', () => {
    expect(parseSetCookie('nonsense')).toBeNull();
    expect(parseSetCookie('=novalue')).toBeNull();
  });
});

describe('channelUrlFromDeeplink', () => {
  it('rewrites a Mattermost deeplink onto the origin we serve it from', () => {
    expect(
      channelUrlFromDeeplink(
        'mattermost://localhost:8065/switch/channels/town-square',
        'http://127.0.0.1:51002'
      )
    ).toBe('http://127.0.0.1:51002/switch/channels/town-square');
  });

  it('keeps channel names containing dashes intact', () => {
    // Bridged channels are named after the room, so double dashes are common
    // and were an early suspect for the blank-page bug.
    expect(
      channelUrlFromDeeplink(
        'mattermost://localhost:8065/switch/channels/mattermost--off-topic',
        'http://127.0.0.1:8065'
      )
    ).toBe('http://127.0.0.1:8065/switch/channels/mattermost--off-topic');
  });

  it('tolerates a trailing slash on the origin', () => {
    expect(
      channelUrlFromDeeplink('mattermost://host/switch/channels/x', 'http://127.0.0.1:8065/')
    ).toBe('http://127.0.0.1:8065/switch/channels/x');
  });

  it('returns null for a non-Mattermost deeplink rather than mangling it', () => {
    expect(channelUrlFromDeeplink('slack://channel?id=C123', 'http://127.0.0.1:8065')).toBeNull();
  });

  it('returns null when the deeplink names no channel path', () => {
    expect(channelUrlFromDeeplink('mattermost://localhost:8065', 'http://x')).toBeNull();
  });
});

describe('mattermostPartition', () => {
  it('is per-server, so two servers cannot share a session', () => {
    expect(mattermostPartition('a')).not.toBe(mattermostPartition('b'));
  });

  it('is persistent, so the session survives a pane remount', () => {
    expect(mattermostPartition('a').startsWith('persist:')).toBe(true);
  });
});
