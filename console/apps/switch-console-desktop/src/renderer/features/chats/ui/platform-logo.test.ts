import { describe, expect, it } from 'vitest';
import { platformLogoMarkdown, platformOfLogoUrl } from './platform-logo';

describe('platform logos in chat messages', () => {
  it('writes a logo the chat reads back', () => {
    expect(platformLogoMarkdown('slack', 'Slack')).toBe('![Slack](switchdash://logo/slack)');
    expect(platformOfLogoUrl('switchdash://logo/slack')).toBe('slack');
  });

  it('leaves every other image alone', () => {
    expect(platformOfLogoUrl('https://example.com/slack.png')).toBeNull();
    expect(platformOfLogoUrl('switchdash://open/agents')).toBeNull();
    expect(platformOfLogoUrl(undefined)).toBeNull();
  });

  it('refuses an address that is not a platform name', () => {
    expect(platformOfLogoUrl('switchdash://logo/')).toBeNull();
    expect(platformOfLogoUrl('switchdash://logo/../etc')).toBeNull();
    expect(platformOfLogoUrl('switchdash://logo/Slack')).toBeNull();
  });
});
