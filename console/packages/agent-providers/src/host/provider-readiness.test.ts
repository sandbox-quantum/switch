import { describe, expect, it } from 'vitest';
import { checkProviderReadiness, parseAuthentication } from './provider-readiness';

describe('provider authentication', () => {
  it('recognizes signed-out Claude without assuming an installed CLI is ready', () => {
    expect(parseAuthentication('claude', '{"loggedIn":false}').status).toBe('unauthenticated');
  });
  it('accepts native API-key authentication', () => {
    expect(parseAuthentication('claude', '{"loggedIn":true,"authMethod":"api-key"}').status).toBe(
      'authenticated'
    );
  });
  it('does not return account details to the renderer', () => {
    expect(parseAuthentication('cursor', 'User Email: user@example.com')).toEqual({
      status: 'authenticated',
      message: 'Signed in.',
      models: [],
    });
  });
  it('accepts Cursor table output without a colon', () => {
    expect(parseAuthentication('cursor', 'User Email          user@example.com').status).toBe(
      'authenticated'
    );
  });
  it('recognizes signed-out Cursor', () => {
    expect(parseAuthentication('cursor', 'User Email: Not logged in').status).toBe(
      'unauthenticated'
    );
  });
  it('keeps an unsupported status command inconclusive', () => {
    expect(parseAuthentication('cursor', 'Unknown command about').status).toBe('unknown');
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
