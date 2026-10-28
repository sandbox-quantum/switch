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
  });

  it('creates an adapter instance', () => {
    const adapter = createGrokBuildAdapter();
    expect(adapter).toBeDefined();
    expect(typeof adapter.startSession).toBe('function');
  });
});
