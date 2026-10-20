import { describe, expect, it } from 'vitest';
import {
  channelCleanupText,
  channelKeptText,
  channelOnDeleteSummary,
  channelOnDeleteText,
  isRetirable,
  retireChannelLabel,
} from './room-delete-wording';

describe('isRetirable', () => {
  it('offers the choice only where retiring does something', () => {
    expect(isRetirable('archived')).toBe(true);
    expect(isRetirable('deleted')).toBe(true);
    expect(isRetirable('left')).toBe(true);
    expect(isRetirable('kept')).toBe(false);
    expect(isRetirable(null)).toBe(false);
    expect(isRetirable(undefined)).toBe(false);
  });
});

describe('retireChannelLabel', () => {
  it('names what retiring does on each platform', () => {
    expect(retireChannelLabel('Slack', 'archived')).toBe('Also archive the Slack channel');
    expect(retireChannelLabel('Discord', 'deleted')).toBe('Also delete the Discord channel');
    expect(retireChannelLabel('Telegram', 'left')).toBe(
      'Also have the bot leave the Telegram chat'
    );
  });
});

describe('channelKeptText', () => {
  it('says the channel stays and stops syncing', () => {
    expect(channelKeptText('Slack', 'archived')).toBe(
      'The Slack channel stays as it is; Switch stops syncing it.'
    );
  });

  it('calls a Telegram chat a chat', () => {
    expect(channelKeptText('Telegram', 'left')).toBe(
      'The Telegram chat stays as it is; Switch stops syncing it.'
    );
  });
});

describe('channelOnDeleteSummary', () => {
  it('says the channel is kept unless retiring is chosen', () => {
    expect(channelOnDeleteSummary('Slack', 'archived')).toBe(
      'Its Slack channel is kept unless you choose to archive it.'
    );
    expect(channelOnDeleteSummary('Discord', 'deleted')).toBe(
      'Its Discord channel is kept unless you choose to delete it.'
    );
    expect(channelOnDeleteSummary('Telegram', 'left')).toBe(
      'The bot stays in the Telegram chat unless you choose to have it leave.'
    );
  });

  it('falls back to the fixed wording where there is no choice', () => {
    expect(channelOnDeleteSummary('Microsoft Teams', 'kept')).toBe(
      'Its Microsoft Teams channel stays in Microsoft Teams; remove it there.'
    );
    expect(channelOnDeleteSummary('Slack', null)).toBeNull();
    expect(channelOnDeleteSummary('Slack', undefined)).toBe(
      'The Slack channel may remain after the room is deleted.'
    );
  });
});

describe('channelOnDeleteText', () => {
  it('says a Slack channel will be archived, not deleted', () => {
    expect(channelOnDeleteText('Slack', 'archived')).toBe('Its Slack channel will be archived.');
  });

  it('says a Discord channel will be deleted', () => {
    expect(channelOnDeleteText('Discord', 'deleted')).toBe('Its Discord channel will be deleted.');
  });

  it('says the bot will leave a Telegram chat', () => {
    expect(channelOnDeleteText('Telegram', 'left')).toContain(
      'The bot will leave the Telegram chat'
    );
  });

  it('says a Teams channel stays and has to be removed in Teams', () => {
    expect(channelOnDeleteText('Microsoft Teams', 'kept')).toBe(
      'Its Microsoft Teams channel stays in Microsoft Teams; remove it there.'
    );
  });

  it('claims nothing beyond "may remain" when the server does not say', () => {
    expect(channelOnDeleteText('Slack', undefined)).toBe(
      'The Slack channel may remain after the room is deleted.'
    );
  });

  it('says nothing about a channel the room does not have', () => {
    expect(channelOnDeleteText('Slack', null)).toBeNull();
  });
});

describe('channelCleanupText', () => {
  it('asks for a channel Slack would not archive to be archived by hand', () => {
    const text = channelCleanupText('Slack', 'archived', {
      outcome: 'failed',
      reason: 'The Switch app is no longer in this Slack channel',
    });

    expect(text).toContain('could not be archived');
    expect(text).toContain('no longer in this Slack channel');
    expect(text).toContain('Archive it in Slack by hand.');
  });

  it('has nothing to say when the channel was retired or kept', () => {
    expect(
      channelCleanupText('Slack', 'archived', { outcome: 'archived', reason: null })
    ).toBeNull();
    // A kept channel comes back null.
    expect(channelCleanupText('Slack', 'archived', null)).toBeNull();
  });

  it('still asks for cleanup when the planned outcome was never read', () => {
    expect(channelCleanupText('Slack', undefined, { outcome: 'failed', reason: null })).toBe(
      'The room was deleted, but its Slack channel was not cleaned up. Remove it in Slack by hand.'
    );
  });
});
