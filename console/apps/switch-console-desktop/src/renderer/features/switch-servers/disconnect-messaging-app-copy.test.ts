import { describe, expect, it } from 'vitest';
import { disconnectMessagingAppParagraphs } from './disconnect-messaging-app-copy';

describe('disconnectMessagingAppParagraphs', () => {
  it('warns an ordinary bridge takes its rooms with it', () => {
    const paragraphs = disconnectMessagingAppParagraphs({
      bridgeDisplayName: 'Acme Slack',
      teamPlacementSupported: false,
    });

    expect(paragraphs[0]).toMatch(/deletes every Switch room/);
    expect(paragraphs[0]).toMatch(/can.t be undone/);
    expect(paragraphs[1]).toContain('Acme Slack');
    expect(paragraphs[1]).toMatch(/are not deleted/);
  });

  it('does not claim a distributed Teams disconnect deletes any room', () => {
    const paragraphs = disconnectMessagingAppParagraphs({
      bridgeDisplayName: 'Contoso Teams',
      teamPlacementSupported: true,
    });

    for (const p of paragraphs) expect(p).not.toMatch(/deletes every Switch room/);
    expect(paragraphs.join(' ')).toMatch(/internal-only/);
    expect(paragraphs[0]).toContain('Contoso Teams');
  });

  it('says removing the app from the organisation is a Microsoft admin’s job', () => {
    const paragraphs = disconnectMessagingAppParagraphs({
      bridgeDisplayName: 'Contoso Teams',
      teamPlacementSupported: true,
    });

    expect(paragraphs.join(' ')).toMatch(/Teams admin center/);
    expect(paragraphs.join(' ')).toMatch(/Microsoft Entra admin center/);
  });
});
