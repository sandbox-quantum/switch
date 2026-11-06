import { describe, expect, it } from 'vitest';
import {
  checkQwenSignIn,
  parseQwenAuth,
  QWEN_LOGIN,
  qwenAcp,
  qwenSessionMode,
} from './qwen-acp';

describe('qwenAcp', () => {
  it('defines provider hooks with expected launch and login commands', () => {
    expect(qwenAcp.provider).toBe('qwen');
    expect(qwenAcp.label).toBe('Qwen Code');
    expect(qwenAcp.defaultBinary).toBe('qwen');
    expect(qwenAcp.loginCommand).toBe('qwen login');
    expect(qwenAcp.inheritEnv).toContain('DASHSCOPE_API_KEY');
    expect(qwenAcp.inheritEnv).toContain('QWEN_API_KEY');

    const launchConfig = qwenAcp.launch({
      binaryPath: '/usr/local/bin/qwen',
      cwd: '/work',
      env: { DASHSCOPE_API_KEY: 'test-key' },
    });
    expect(launchConfig).toEqual({
      command: '/usr/local/bin/qwen',
      args: ['--acp'],
      env: { DASHSCOPE_API_KEY: 'test-key' },
    });
  });

  describe('parseQwenAuth', () => {
    it('detects unauthenticated status when output mentions not logged in', () => {
      const result = parseQwenAuth('Error: user is not logged in. Please authenticate.');
      expect(result.status).toBe('unauthenticated');
      expect(result.message).toContain(QWEN_LOGIN);
    });

    it('detects unauthenticated status when authentication is required', () => {
      const result = parseQwenAuth('Authentication required');
      expect(result.status).toBe('unauthenticated');
      expect(result.message).toContain(QWEN_LOGIN);
    });

    it('detects authenticated status and extracts user email', () => {
      const result = parseQwenAuth('Account: dev@qwen.ai (active)');
      expect(result.status).toBe('authenticated');
      expect(result.message).toContain('dev@qwen.ai');
    });

    it('detects authenticated status with generic confirmation', () => {
      const result = parseQwenAuth('Qwen Code authentication status: ok');
      expect(result.status).toBe('authenticated');
    });
  });

  describe('qwenSessionMode', () => {
    const modes = {
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'ask', name: 'Ask' },
        { id: 'accept-edits', name: 'Accept edits' },
        { id: 'auto-approve', name: 'Auto approve' },
      ],
      currentMode: 'default',
    };

    it('maps runtime modes to the preferred Qwen ACP mode', () => {
      expect(qwenSessionMode('full-access', modes)).toBe('auto-approve');
      expect(qwenSessionMode('auto-accept-edits', modes)).toBe('accept-edits');
      expect(qwenSessionMode('auto', modes)).toBe('accept-edits');
      expect(qwenSessionMode('approval-required', modes)).toBe('ask');
    });

    it('returns undefined if modes are not provided', () => {
      expect(qwenSessionMode('full-access', undefined)).toBeUndefined();
    });
  });

  describe('checkQwenSignIn', () => {
    it('returns authenticated immediately when DASHSCOPE_API_KEY is provided in env', async () => {
      const result = await checkQwenSignIn({
        binaryPath: 'qwen',
        cwd: '/work',
        env: { DASHSCOPE_API_KEY: 'test-secret-key' },
        handshake: async () => {
          throw new Error('should not call handshake when api key is present');
        },
        request: async () => {
          throw new Error('should not request when api key is present');
        },
      });
      expect(result.status).toBe('authenticated');
      expect(result.message).toContain('Qwen API key');
    });

    it('returns authenticated immediately when QWEN_API_KEY is provided in env', async () => {
      const result = await checkQwenSignIn({
        binaryPath: 'qwen',
        cwd: '/work',
        env: { QWEN_API_KEY: 'test-qwen-key' },
        handshake: async () => {
          throw new Error('should not call handshake when api key is present');
        },
        request: async () => {
          throw new Error('should not request when api key is present');
        },
      });
      expect(result.status).toBe('authenticated');
      expect(result.message).toContain('Qwen API key');
    });
  });
});
