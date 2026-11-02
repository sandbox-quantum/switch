import { describe, expect, it } from 'vitest';
import { CLAUDE_TOO_OLD, parseClaudeAuthStatus, parseClaudeTestReply } from '../claude/sign-in';
import { parseCursorAbout } from '../cursor/cursor-adapter';
import { checkProviderReadiness } from './provider-readiness';

describe('a Cursor API key', () => {
  it('is taken as given: Cursor cannot check one without spending a request', async () => {
    expect(
      await checkProviderReadiness({
        provider: 'cursor',
        binaryPath: '/nonexistent/cursor-agent',
        cwd: '/',
        env: { CURSOR_API_KEY: 'crsr_synthetic' },
      })
    ).toEqual({
      status: 'authenticated',
      message: 'Signs in with the Cursor API key it was given.',
      models: [],
    });
  });
});

describe('provider authentication', () => {
  it('recognizes signed-out Claude without assuming an installed CLI is ready', () => {
    expect(parseClaudeAuthStatus('{"loggedIn":false}').status).toBe('unauthenticated');
  });
  it('says an old Claude Code cannot report its sign-in, instead of failing the check', () => {
    expect(parseClaudeAuthStatus('Usage: claude [options] [command] [prompt]')).toEqual({
      status: 'unknown',
      message: CLAUDE_TOO_OLD,
      models: [],
    });
  });
  it('takes a test prompt that answered as signed in', () => {
    expect(parseClaudeTestReply('{"type":"result","is_error":false,"result":"OK"}').status).toBe(
      'authenticated'
    );
  });
  it('takes a test prompt that failed as not signed in, with what Claude said', () => {
    const answer = parseClaudeTestReply(
      '{"type":"result","is_error":true,"result":"Invalid API key · Fix external API key"}'
    );
    expect(answer.status).toBe('unauthenticated');
    expect(answer.message).toContain('Invalid API key');
  });
  it('reads what went wrong from `errors` when the result does not say', () => {
    const answer = parseClaudeTestReply(
      '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["API Error: 401 OAuth token has expired"]}'
    );
    expect(answer.status).toBe('unauthenticated');
    expect(answer.message).toContain('OAuth token has expired');
  });
  it('shows a failure Claude only wrote to stderr, without calling it too old', () => {
    const answer = parseClaudeTestReply('', 'Error: Could not load credentials from keychain\n');
    expect(answer).toEqual({
      status: 'unknown',
      message:
        'Claude Code could not answer a test prompt ("Error: Could not load credentials from keychain").',
      models: [],
    });
  });
  it('takes a test prompt with options Claude does not know as Claude being too old', () => {
    expect(
      parseClaudeTestReply('', "error: unknown option '--no-session-persistence'").message
    ).toBe(CLAUDE_TOO_OLD);
    expect(parseClaudeTestReply('', '').message).toBe(CLAUDE_TOO_OLD);
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
