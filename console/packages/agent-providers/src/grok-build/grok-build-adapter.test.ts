import { describe, expect, it } from 'vitest';
import { createGrokBuildAdapter, grokBuildAcp, GROK_BUILD_LOGIN } from './grok-build-acp';

describe('grokBuildAcp', () => {
  it('declares the expected provider identification and capabilities', () => {
    expect(grokBuildAcp.provider).toBe('grok-build');
    expect(grokBuildAcp.label).toBe('Grok Build');
    expect(grokBuildAcp.defaultBinary).toBe('grok');
    expect(grokBuildAcp.loginCommand).toBe(GROK_BUILD_LOGIN);
    expect(grokBuildAcp.inheritEnv).toContain('XAI_API_KEY');
    expect(grokBuildAcp.capabilities).toEqual({
      modelSwitchInSession: false,
      steering: false,
      resume: true,
      approvals: true,
      userInput: false,
    });
  });

  it('launches grok with agent stdio', async () => {
    const launch = await grokBuildAcp.launch({
      binaryPath: '/usr/local/bin/grok',
      cwd: '/workspace',
      env: { XAI_API_KEY: 'xai-test-key' },
    });

    expect(launch.command).toBe('/usr/local/bin/grok');
    expect(launch.args).toEqual(['agent', 'stdio']);
    expect(launch.env).toEqual({ XAI_API_KEY: 'xai-test-key' });
  });

  describe('checkSignIn', () => {
    it('reports authenticated when XAI_API_KEY is present', async () => {
      const result = await grokBuildAcp.checkSignIn?.({
        binaryPath: 'grok',
        cwd: '/workspace',
        env: { XAI_API_KEY: 'xai-test-key' },
        handshake: async () => ({}) as never,
      });

      expect(result).toBeDefined();
      expect(result?.status).toBe('authenticated');
      expect(result?.message).toContain('xAI API key');
    });

    it('reports unknown with sign-in instructions when XAI_API_KEY is missing', async () => {
      const result = await grokBuildAcp.checkSignIn?.({
        binaryPath: 'grok',
        cwd: '/workspace',
        env: {},
        handshake: async () => ({}) as never,
      });

      expect(result).toBeDefined();
      expect(result?.status).toBe('unknown');
      expect(result?.message).toContain(GROK_BUILD_LOGIN);
    });

    it('reports unknown when XAI_API_KEY is only whitespace', async () => {
      const result = await grokBuildAcp.checkSignIn?.({
        binaryPath: 'grok',
        cwd: '/workspace',
        env: { XAI_API_KEY: '   ' },
        handshake: async () => ({}) as never,
      });

      expect(result).toBeDefined();
      expect(result?.status).toBe('unknown');
    });

    it('reports authenticated when handshake returns cached_token authMethod', async () => {
      const result = await grokBuildAcp.checkSignIn?.({
        binaryPath: 'grok',
        cwd: '/workspace',
        env: {},
        handshake: async () =>
          ({
            authMethods: [{ id: 'cached_token', name: 'Cached Token' }],
          }) as never,
      });

      expect(result).toBeDefined();
      expect(result?.status).toBe('authenticated');
      expect(result?.message).toContain('Signed in to Grok Build');
    });

    it('reports unauthenticated when handshake returns login methods without cached_token', async () => {
      const result = await grokBuildAcp.checkSignIn?.({
        binaryPath: 'grok',
        cwd: '/workspace',
        env: {},
        handshake: async () =>
          ({
            authMethods: [{ id: 'grok.com', name: 'Grok.com' }],
          }) as never,
      });

      expect(result).toBeDefined();
      expect(result?.status).toBe('unauthenticated');
      expect(result?.message).toContain(GROK_BUILD_LOGIN);
    });

    it('reports unauthenticated when handshake throws an auth error', async () => {
      const result = await grokBuildAcp.checkSignIn?.({
        binaryPath: 'grok',
        cwd: '/workspace',
        env: {},
        handshake: async () => {
          throw new Error('User is unauthenticated');
        },
      });

      expect(result).toBeDefined();
      expect(result?.status).toBe('unauthenticated');
      expect(result?.message).toContain(GROK_BUILD_LOGIN);
    });
  });

  describe('mcpServerOf', () => {
    it('extracts server name from rawInput.tool_name', () => {
      const server = grokBuildAcp.mcpServerOf?.({
        rawInput: { tool_name: 'echo__switch_echo' },
      } as never);
      expect(server).toBe('echo');
    });

    it('extracts server name from title with __ delimiter', () => {
      const server = grokBuildAcp.mcpServerOf?.({
        title: 'echo__switch_echo',
      } as never);
      expect(server).toBe('echo');
    });

    it('extracts server name from rawOutput.server_name', () => {
      const server = grokBuildAcp.mcpServerOf?.({
        title: 'switch_echo',
        rawOutput: { server_name: 'echo' },
      } as never);
      expect(server).toBe('echo');
    });

    it('returns undefined when no server identifier is found', () => {
      const server = grokBuildAcp.mcpServerOf?.({
        title: 'bash',
        rawInput: { command: 'ls' },
      } as never);
      expect(server).toBeUndefined();
    });
  });

  it('creates an adapter instance', () => {
    const adapter = createGrokBuildAdapter();
    expect(adapter).toBeDefined();
    expect(typeof adapter.startSession).toBe('function');
  });
});
