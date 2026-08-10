import { describe, expect, it } from 'vitest';
import { buildConnectPrompt } from './build-connect-prompt';

describe('buildConnectPrompt', () => {
  it('returns undefined when there is no room and no prompt', () => {
    expect(buildConnectPrompt(null, null, '   ')).toBeUndefined();
  });

  it('returns just the user prompt when no room is chosen', () => {
    expect(buildConnectPrompt(null, null, '  fix the bug  ')).toBe('fix the bug');
  });

  it('ignores a role when no room is chosen', () => {
    expect(buildConnectPrompt(null, 'Reviewer', 'fix the bug')).toBe('fix the bug');
  });

  it('returns just the connect line when no user prompt is given', () => {
    expect(buildConnectPrompt('Workforce hub', null, '')).toBe(
      'Connect to the Switch room "Workforce hub".'
    );
  });

  it('prepends the connect line to the user prompt', () => {
    expect(buildConnectPrompt('Workforce hub', null, 'fix the bug')).toBe(
      'Connect to the Switch room "Workforce hub".\n\nfix the bug'
    );
  });

  it('includes the role in the connect line when one is chosen', () => {
    expect(buildConnectPrompt('Workforce hub', 'Reviewer', '')).toBe(
      'Connect to the Switch room "Workforce hub" and assume the "Reviewer" role.'
    );
  });

  it('prepends the room+role connect line to the user prompt', () => {
    expect(buildConnectPrompt('Workforce hub', 'Reviewer', 'fix the bug')).toBe(
      'Connect to the Switch room "Workforce hub" and assume the "Reviewer" role.\n\nfix the bug'
    );
  });
});
