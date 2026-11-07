import { describe, expect, it } from 'vitest';
import { CLINE_LOGIN, clineAcp } from './cline-adapter';

describe('clineAcp hooks', () => {
  it('runs cline in ACP mode with no extra flags', () => {
    expect(clineAcp.launch({ binaryPath: '/usr/bin/cline', cwd: '/work', env: { X: '1' } })).toEqual({
      command: '/usr/bin/cline',
      args: ['--acp'],
      env: { X: '1' },
    });
  });

  it('pins every runtime mode to Act, since Cline enforces permissions instead of modes', () => {
    for (const mode of ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const) {
      expect(clineAcp.sessionMode?.(mode, undefined)).toBe('act');
    }
  });

  it('defines the expected login command', () => {
    expect(clineAcp.loginCommand).toBe(CLINE_LOGIN);
    expect(CLINE_LOGIN).toBe('cline auth');
  });

  it('trusts a given API key without starting a process', async () => {
    const result = await clineAcp.checkSignIn!({
      binaryPath: '/usr/bin/cline',
      cwd: '/work',
      env: { CLINE_API_KEY: 'sk-test' },
      handshake: async () => {
        throw new Error('should not be called');
      },
      request: async () => {
        throw new Error('should not be called');
      },
    });
    expect(result.status).toBe('authenticated');
    expect(result.message).toContain('API key');
  });

  it('trusts an Anthropic or OpenAI API key without starting a process', async () => {
    const result = await clineAcp.checkSignIn!({
      binaryPath: '/usr/bin/cline',
      cwd: '/work',
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      handshake: async () => {
        throw new Error('should not be called');
      },
      request: async () => {
        throw new Error('should not be called');
      },
    });
    expect(result.status).toBe('authenticated');
  });

  it('reports signed in when session/new succeeds', async () => {
    let handshakeCalled = false;
    let sessionNewCalled = false;
    const result = await clineAcp.checkSignIn!({
      binaryPath: '/usr/bin/cline',
      cwd: '/work',
      env: {},
      handshake: async () => {
        handshakeCalled = true;
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
          authMethods: [{ id: 'cline', name: 'Sign in' }],
        };
      },
      request: async (method) => {
        if (method === 'session/new') {
          sessionNewCalled = true;
          return { sessionId: 's1' };
        }
        throw new Error(`Unexpected request: ${method}`);
      },
    });
    expect(handshakeCalled).toBe(true);
    expect(sessionNewCalled).toBe(true);
    expect(result.status).toBe('authenticated');
    expect(result.message).toBe('Signed in.');
  });

  it('hints to sign in when session/new reports authentication required', async () => {
    const result = await clineAcp.checkSignIn!({
      binaryPath: '/usr/bin/cline',
      cwd: '/work',
      env: {},
      handshake: async () => ({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: [{ id: 'cline', name: 'Sign in' }],
      }),
      request: async () => {
        throw new Error('Authentication required: Call authenticate before starting a session');
      },
    });
    expect(result.status).toBe('unauthenticated');
    expect(result.message).toContain('cline auth');
  });

  it.each([
    ['echo__switch_echo: {"text":"PROBE"}', 'echo'],
    ['google-workspace__gmail_search: {}', 'google-workspace'],
    ['composio_search_tools: {"queries":[{"use_case":"echo"}]}', undefined],
    ['run_commands: {"commands":["ls"]}', undefined],
    ['read_files: {"paths":["a__b.ts"]}', undefined],
    [undefined, undefined],
  ])('reads the MCP server from tool title %s', (title, expectedServer) => {
    expect(clineAcp.mcpServerOf!({ toolCallId: 'c1', title })).toBe(expectedServer);
  });

  it('identifies subagent calls from spawn_agent tool titles', () => {
    expect(clineAcp.itemType!({ toolCallId: 'c1', title: 'spawn_agent: Read the README' })).toBe(
      'subagent'
    );
    expect(clineAcp.itemType!({ toolCallId: 'c1', title: 'run_commands: ls' })).toBeUndefined();
    expect(clineAcp.itemType!({ toolCallId: 'c1', title: undefined })).toBeUndefined();
  });
});
