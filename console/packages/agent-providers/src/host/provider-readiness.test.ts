import { describe, expect, it } from 'vitest';
import { parseClaudeAuthStatus } from '../claude/sign-in';
import { parseCursorAbout } from '../cursor/cursor-adapter';
import { checkProviderReadiness } from './provider-readiness';

describe('provider authentication', () => {
  it('recognizes signed-out Claude without assuming an installed CLI is ready', () => {
    expect(parseClaudeAuthStatus('{"loggedIn":false}').status).toBe('unauthenticated');
  });
  it('accepts native API-key authentication', () => {
    expect(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"api-key"}').status).toBe(
      'authenticated'
    );
  });
  it('does not return account details to the renderer', () => {
    expect(parseCursorAbout('User Email: user@example.com')).toEqual({
      status: 'authenticated',
      message: 'Signed in.',
      models: [],
    });
  });
  it('accepts Cursor table output without a colon', () => {
    expect(parseCursorAbout('User Email          user@example.com').status).toBe('authenticated');
  });
  it('recognizes signed-out Cursor', () => {
    expect(parseCursorAbout('User Email: Not logged in').status).toBe('unauthenticated');
  });
  it('keeps an unsupported status command inconclusive', () => {
    expect(parseCursorAbout('Unknown command about').status).toBe('unknown');
  });
  it('does not turn a missing executable into a signed-out result', async () => {
    expect(
      (
        await checkProviderReadiness({
          provider: 'claude',
          binaryPath: '/nonexistent/provider',
          cwd: process.cwd(),
          env: {},
        })
      ).status
    ).toBe('unknown');
  });
});

it.each(['Not logged in. Run agent login.', 'Authentication required', 'Not signed in'])(
  'recognizes signed-out Cursor without an account row: %s',
  (output) => {
    expect(parseCursorAbout(output).status).toBe('unauthenticated');
  }
);
