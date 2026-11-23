import { describe, expect, it } from 'vitest';
import { isAllowedExternalUrl, isHttpUrl, isWebContentUrl } from './external-url-policy';

describe('isAllowedExternalUrl', () => {
  it.each([
    'https://example.com',
    'http://localhost:3000',
    'slack://channel?team=T1&id=C1',
    'mattermost://chat.example.com/team/channels/room',
    'discord://discord.com/channels/1/2',
  ])('lets Console open %s', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(true);
  });

  it.each([
    'file:///Applications/Calculator.app',
    'javascript:alert(1)',
    'mailto:someone@example.com',
    'search-ms:query=x',
    'some-app://run',
    'not a url',
  ])('refuses %s', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(false);
  });
});

describe('isHttpUrl and isWebContentUrl', () => {
  it('tells a web address from documents a page makes and from other schemes', () => {
    expect(isHttpUrl('https://example.com')).toBe(true);
    expect(isHttpUrl('about:blank')).toBe(false);
    expect(isWebContentUrl('about:blank')).toBe(true);
    expect(isWebContentUrl('blob:https://example.com/1')).toBe(true);
    expect(isWebContentUrl('data:text/html,hi')).toBe(true);
    expect(isWebContentUrl('file:///etc/passwd')).toBe(false);
    expect(isWebContentUrl('some-app://run')).toBe(false);
  });
});
