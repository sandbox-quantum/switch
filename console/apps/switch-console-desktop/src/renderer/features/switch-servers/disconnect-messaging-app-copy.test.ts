import { describe, expect, it } from 'vitest';
import { disconnectMessagingAppParagraphs } from './disconnect-messaging-app-copy';

describe('disconnectMessagingAppParagraphs', () => {
  it('warns that a bridge registered with credentials takes its rooms with it', () => {
    const text = disconnectMessagingAppParagraphs({
      bridgeDisplayName: 'Acme',
      bridgeType: 'slack',
      installState: 'not-installed',
    }).join(' ');
    expect(text).toContain('deletes every Switch room');
  });

  it('says an installed app keeps its rooms as internal-only', () => {
    const text = disconnectMessagingAppParagraphs({
      bridgeDisplayName: 'Acme',
      bridgeType: 'slack',
      installState: 'installed',
    }).join(' ');
    expect(text).toContain('not deleted');
    expect(text).not.toContain('deletes every Switch room');
  });

  it('says what disconnecting the distributed Teams app does and does not remove', () => {
    const text = disconnectMessagingAppParagraphs({
      bridgeDisplayName: 'Contoso',
      bridgeType: 'teams',
      installState: 'installed',
    }).join(' ');
    expect(text).toContain('leaves every team');
    expect(text).toContain('Microsoft Entra admin center');
  });

  it('shows the strongest warning until it is known which it is', () => {
    for (const installState of [null, 'unknown'] as const) {
      const text = disconnectMessagingAppParagraphs({
        bridgeDisplayName: 'Acme',
        bridgeType: 'teams',
        installState,
      }).join(' ');
      expect(text).toContain('deletes every Switch room');
    }
  });

  it('says every Telegram chat goes, keeping its room, and then the connection', () => {
    const text = disconnectMessagingAppParagraphs({
      bridgeDisplayName: 'Telegram',
      bridgeType: 'telegram',
      installState: 'installed',
    }).join(' ');

    expect(text).toContain('Every chat connected through Telegram is disconnected');
    expect(text).toContain('internal-only');
    expect(text).toContain('connection itself is removed');
    expect(text).not.toContain('deletes every Switch room');
  });
});
