import { describe, expect, it } from 'vitest';
import {
  connectFormFields,
  isMissingRequired,
  missingFieldsMessage,
  unreachableFromInternet,
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
      'Bot token is required to connect.'
    );
    expect(missingFieldsMessage(fields, {})).toBe('Bot token, Server ID are required to connect.');
    expect(missingFieldsMessage(fields, { guild_id: '123', bot_token: 'tok' })).toBeNull();
  });

  it('counts a boolean answer as given, false included', () => {
    const toggle: BridgeConfigField = { ...field('flag', 'Flag', true), kind: 'boolean' };

    expect(isMissingRequired(toggle, { flag: false })).toBe(false);
  });
});

describe('the connect form labels', () => {
  it('names Discord, Telegram and Teams fields in plain words', () => {
    const labels = (platform: string, keys: string[]) =>
      connectFormFields(
        platform,
        keys.map((key) => field(key, key, true)),
        []
      ).map((f) => f.label);

    expect(labels('discord', ['bot_token', 'guild_id'])).toEqual(['Bot token', 'Server ID']);
    expect(labels('telegram', ['bot_token', 'bot_username'])).toEqual([
      'Bot token',
      'Bot username',
    ]);
    expect(
      labels('teams', ['app_id', 'app_password', 'tenant_id', 'team_id', 'public_base_url'])
    ).toEqual([
      'App ID',
      'App password (client secret)',
      'Directory (tenant) ID',
      'Team ID',
      'Public HTTPS address',
    ]);
  });

  it('keeps the server’s label for a field it has no words for', () => {
    expect(connectFormFields('discord', [field('new_knob', 'New Knob', false)], [])[0]?.label).toBe(
      'New Knob'
    );
  });
});

describe('whether Microsoft could reach the server', () => {
  const server = (
    url: string,
    managed = false,
    managementKind: 'local' | 'remote' | null = null
  ) => ({
    url,
    managed,
    managementKind,
  });

  it('cannot reach one Switch Console runs on this computer', () => {
    expect(unreachableFromInternet(server('https://switch.example.com', true, 'local'))).toBe(true);
  });

  it.each([
    'http://127.0.0.1:8000',
    'http://localhost:8000',
    'http://10.0.0.5',
    'http://172.20.1.1',
    'http://192.168.1.10:8000',
    'https://switch.local',
    'http://[::1]:8000',
    'http://[fd12::1]',
  ])('cannot reach %s', (url) => {
    expect(unreachableFromInternet(server(url))).toBe(true);
  });

  it.each(['https://switch.example.com', 'https://172.32.0.1', 'https://203.0.113.9'])(
    'can reach %s',
    (url) => {
      expect(unreachableFromInternet(server(url))).toBe(false);
    }
  );

  it('can reach one Console runs on an SSH host at a public address', () => {
    expect(unreachableFromInternet(server('https://switch.example.com', true, 'remote'))).toBe(
      false
    );
  });
});
