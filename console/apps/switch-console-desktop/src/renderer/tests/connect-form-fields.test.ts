import { describe, expect, it } from 'vitest';
import {
  connectFormFields,
  isMissingRequired,
  missingFieldsMessage,
} from '@renderer/features/switch-servers/connect-form-fields';
import type { BridgeConfigField } from '@shared/core/switch-servers/switch-servers';

function field(key: string, label: string, required: boolean): BridgeConfigField {
  return { key, label, description: null, required, secret: false, kind: 'string', default: null };
}

// What a server that predates the fix sends: the token optional, since the
// model also serves shared bridges that carry none.
const discordFields = [field('bot_token', 'Bot Token', false), field('guild_id', 'Guild Id', true)];

describe('the connect form fields', () => {
  it('asks for a Discord bot token as required, whatever the schema says', () => {
    const fields = connectFormFields('discord', discordFields, []);

    expect(fields.find((f) => f.key === 'bot_token')?.required).toBe(true);
  });

  it('leaves another platform’s optional fields optional', () => {
    const fields = connectFormFields('mattermost', [field('team', 'Team', false)], []);

    expect(fields[0]?.required).toBe(false);
  });

  it('marks what a setup guide adds as required too', () => {
    const fields = connectFormFields(
      'slack',
      [field('app_token', 'App Token', false)],
      ['app_token']
    );

    expect(fields[0]?.required).toBe(true);
  });

  it('names the blank Discord bot token as what is still needed', () => {
    const fields = connectFormFields('discord', discordFields, []);

    expect(missingFieldsMessage(fields, { guild_id: '123', bot_token: '  ' })).toBe(
      'Bot Token is required to connect.'
    );
    expect(missingFieldsMessage(fields, {})).toBe('Bot Token, Guild Id are required to connect.');
    expect(missingFieldsMessage(fields, { guild_id: '123', bot_token: 'tok' })).toBeNull();
  });

  it('counts a boolean answer as given, false included', () => {
    const toggle: BridgeConfigField = { ...field('flag', 'Flag', true), kind: 'boolean' };

    expect(isMissingRequired(toggle, { flag: false })).toBe(false);
  });
});
