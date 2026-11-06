import { describe, expect, it } from 'vitest';
import {
  checkGrokSignIn,
  GROK_LOGIN,
  grokAcp,
  grokSessionMode,
  parseGrokAuth,
} from './grok-acp';

describe('grokAcp', () => {
  it('defines provider hooks with expected launch and login commands', () => {
    expect(grokAcp.provider).toBe('grok');
    expect(grokAcp.label).toBe('Grok Build');
    expect(grokAcp.defaultBinary).toBe('grok');
    expect(grokAcp.loginCommand).toBe('grok login');
    expect(grokAcp.inheritEnv).toContain('XAI_API_KEY');
    expect(grokAcp.inheritEnv).toContain('GROK_API_KEY');

    const launchConfig = grokAcp.launch({
      binaryPath: '/usr/local/bin/grok',
      cwd: '/work',
      env: { XAI_API_KEY: 'test-key' },
    });
    expect(launchConfig).toEqual({
      command: '/usr/local/bin/grok',
      args: ['--acp'],
      env: { XAI_API_KEY: 'test-key' },
    });
  });

  describe('parseGrokAuth', () => {
    it('detects unauthenticated status when output mentions not logged in', () => {
      const result = parseGrokAuth('Error: user is not logged in. Please authenticate.');
      expect(result.status).toBe('unauthenticated');
      expect(result.message).toContain(GROK_LOGIN);
    });

    it('detects unauthenticated status when authentication is required', () => {
      const result = parseGrokAuth('Authentication required');
      expect(result.status).toBe('unauthenticated');
      expect(result.message).toContain(GROK_LOGIN);
    });

    it('detects authenticated status and extracts user email', () => {
      const result = parseGrokAuth('Account: dev@x.ai (active)');
      expect(result.status).toBe('authenticated');
      expect(result.message).toContain('dev@x.ai');
    });

    it('detects authenticated status with generic confirmation', () => {
      const result = parseGrokAuth('Grok Build authentication status: ok');
      expect(result.status).toBe('authenticated');
    });
  });

  describe('grokSessionMode', () => {
    const modes = {
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'ask', name: 'Ask' },
        { id: 'accept-edits', name: 'Accept edits' },
        { id: 'auto-approve', name: 'Auto approve' },
      ],
      currentMode: 'default',
    };

    it('maps runtime modes to the preferred Grok ACP mode', () => {
      expect(grokSessionMode('full-access', modes)).toBe('auto-approve');
      expect(grokSessionMode('auto-accept-edits', modes)).toBe('accept-edits');
      expect(grokSessionMode('auto', modes)).toBe('accept-edits');
      expect(grokSessionMode('approval-required', modes)).toBe('ask');
    });

    it('returns undefined if modes are not provided', () => {
      expect(grokSessionMode('full-access', undefined)).toBeUndefined();
    });
  });

  describe('checkGrokSignIn', () => {
    it('returns authenticated immediately when XAI_API_KEY is provided in env', async () => {
      const result = await checkGrokSignIn({
        binaryPath: 'grok',
        cwd: '/work',
        env: { XAI_API_KEY: 'test-secret-key' },
        handshake: async () => {
          throw new Error('should not call handshake when api key is present');
        },
        request: async () => {
          throw new Error('should not request when api key is present');
        },
      });
      expect(result.status).toBe('authenticated');
      expect(result.message).toContain('xAI API key');
    });

    it('returns authenticated immediately when GROK_API_KEY is provided in env', async () => {
      const result = await checkGrokSignIn({
        binaryPath: 'grok',
        cwd: '/work',
        env: { GROK_API_KEY: 'test-grok-key' },
        handshake: async () => {
          throw new Error('should not call handshake when api key is present');
        },
        request: async () => {
          throw new Error('should not request when api key is present');
        },
      });
      expect(result.status).toBe('authenticated');
      expect(result.message).toContain('Grok');
    });
  });
});
