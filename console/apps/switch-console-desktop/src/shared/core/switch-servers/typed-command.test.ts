import { describe, expect, it } from 'vitest';
import { typedCommand } from './typed-command';

describe('typedCommand', () => {
  it('fills in the server’s own spelling', () => {
    const bridge = { type: 'telegram', commands: { 'invite-agent': '/invite_agent @{agent}' } };
    expect(typedCommand(bridge, 'invite-agent', { agent: 'buddy' })).toBe('/invite_agent @buddy');
  });

  it('falls back to what an older server took', () => {
    expect(typedCommand({ type: 'telegram', commands: {} }, 'invite-agent', { agent: 'b' })).toBe(
      '/invite_agent @b'
    );
    expect(typedCommand({ type: 'teams', commands: {} }, 'link-account', { code: 'X1' })).toBe(
      '!link-account X1'
    );
  });
});
