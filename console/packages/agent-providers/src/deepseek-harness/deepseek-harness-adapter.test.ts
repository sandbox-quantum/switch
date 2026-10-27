import { describe, expect, it } from 'vitest';
import {
  createDeepseekHarnessAdapter,
  deepseekHarnessAcp,
  DSH_LOGIN,
} from './deepseek-harness-acp';

describe('deepseekHarnessAcp', () => {
  it('declares the expected provider identification and capabilities', () => {
    expect(deepseekHarnessAcp.provider).toBe('deepseek-harness');
    expect(deepseekHarnessAcp.label).toBe('DeepSeek Harness');
    expect(deepseekHarnessAcp.defaultBinary).toBe('dsh');
    expect(deepseekHarnessAcp.loginCommand).toBe(DSH_LOGIN);
    expect(deepseekHarnessAcp.inheritEnv).toContain('DEEPSEEK_API_KEY');
    expect(deepseekHarnessAcp.capabilities).toEqual({
      modelSwitchInSession: false,
      steering: false,
      resume: true,
      approvals: true,
      userInput: false,
    });
  });

  it('launches dsh with --profile acp', async () => {
    const launch = await deepseekHarnessAcp.launch({
      binaryPath: '/custom/path/dsh',
      cwd: '/workspace',
      env: { DEEPSEEK_API_KEY: 'sk-test' },
    });

    expect(launch.command).toBe('/custom/path/dsh');
    expect(launch.args).toEqual(['--profile', 'acp']);
    expect(launch.env).toEqual({ DEEPSEEK_API_KEY: 'sk-test' });
  });

  describe('checkSignIn', () => {
    it('reports authenticated when DEEPSEEK_API_KEY is present', async () => {
      const result = await deepseekHarnessAcp.checkSignIn?.({
        binaryPath: 'dsh',
        cwd: '/workspace',
        env: { DEEPSEEK_API_KEY: 'sk-test-key' },
        handshake: async () => ({}) as never,
      });

      expect(result).toBeDefined();
      expect(result?.status).toBe('authenticated');
      expect(result?.message).toContain('DeepSeek API key');
    });

    it('reports unknown with sign-in instructions when DEEPSEEK_API_KEY is missing', async () => {
      const result = await deepseekHarnessAcp.checkSignIn?.({
        binaryPath: 'dsh',
        cwd: '/workspace',
        env: {},
        handshake: async () => ({}) as never,
      });

      expect(result).toBeDefined();
      expect(result?.status).toBe('unknown');
      expect(result?.message).toContain(DSH_LOGIN);
    });

    it('reports unknown when DEEPSEEK_API_KEY is only whitespace', async () => {
      const result = await deepseekHarnessAcp.checkSignIn?.({
        binaryPath: 'dsh',
        cwd: '/workspace',
        env: { DEEPSEEK_API_KEY: '   ' },
        handshake: async () => ({}) as never,
      });

      expect(result).toBeDefined();
      expect(result?.status).toBe('unknown');
    });
  });

  it('creates an adapter instance', () => {
    const adapter = createDeepseekHarnessAdapter();
    expect(adapter).toBeDefined();
    expect(typeof adapter.startSession).toBe('function');
  });
});
