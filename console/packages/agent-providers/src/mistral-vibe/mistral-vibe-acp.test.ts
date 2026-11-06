import { describe, expect, it } from 'vitest';
import {
  checkMistralVibeSignIn,
  mistralVibeAcp,
  mistralVibeSessionMode,
  parseMistralVibeAuth,
  VIBE_LOGIN,
} from './mistral-vibe-acp';

describe('mistralVibeAcp', () => {
  it('defines provider hooks with expected launch and login commands', () => {
    expect(mistralVibeAcp.provider).toBe('mistral-vibe');
    expect(mistralVibeAcp.label).toBe('Mistral Vibe');
    expect(mistralVibeAcp.defaultBinary).toBe('vibe');
    expect(mistralVibeAcp.loginCommand).toBe('vibe login');
    expect(mistralVibeAcp.inheritEnv).toContain('MISTRAL_API_KEY');

    const launchConfig = mistralVibeAcp.launch({
      binaryPath: '/usr/local/bin/vibe',
      cwd: '/work',
      env: { MISTRAL_API_KEY: 'test-key' },
    });
    expect(launchConfig).toEqual({
      command: '/usr/local/bin/vibe',
      args: ['--acp'],
      env: { MISTRAL_API_KEY: 'test-key' },
    });
  });

  describe('parseMistralVibeAuth', () => {
    it('detects unauthenticated status when output mentions not logged in', () => {
      const result = parseMistralVibeAuth('Error: user is not logged in. Please authenticate.');
      expect(result.status).toBe('unauthenticated');
      expect(result.message).toContain(VIBE_LOGIN);
    });

    it('detects unauthenticated status when authentication is required', () => {
      const result = parseMistralVibeAuth('Authentication required');
      expect(result.status).toBe('unauthenticated');
      expect(result.message).toContain(VIBE_LOGIN);
    });

    it('detects authenticated status and extracts user email', () => {
      const result = parseMistralVibeAuth('Logged in as: dev@mistral.ai (active)');
      expect(result.status).toBe('authenticated');
      expect(result.message).toContain('dev@mistral.ai');
    });

    it('detects authenticated status with generic confirmation', () => {
      const result = parseMistralVibeAuth('Mistral Vibe authentication status: ok');
      expect(result.status).toBe('authenticated');
    });
  });

  describe('mistralVibeSessionMode', () => {
    const modes = {
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'ask', name: 'Ask' },
        { id: 'accept-edits', name: 'Accept edits' },
        { id: 'auto-approve', name: 'Auto approve' },
        { id: 'smart-approve', name: 'Smart approve' },
      ],
      currentMode: 'default',
    };

    it('maps runtime modes to the preferred Vibe ACP mode', () => {
      expect(mistralVibeSessionMode('full-access', modes)).toBe('auto-approve');
      expect(mistralVibeSessionMode('auto-accept-edits', modes)).toBe('accept-edits');
      expect(mistralVibeSessionMode('auto', modes)).toBe('smart-approve');
      expect(mistralVibeSessionMode('approval-required', modes)).toBe('ask');
    });

    it('returns undefined if modes are not provided', () => {
      expect(mistralVibeSessionMode('full-access', undefined)).toBeUndefined();
    });
  });

  describe('checkMistralVibeSignIn', () => {
    it('returns authenticated immediately when MISTRAL_API_KEY is provided in env', async () => {
      const result = await checkMistralVibeSignIn({
        binaryPath: 'vibe',
        cwd: '/work',
        env: { MISTRAL_API_KEY: 'test-secret-key' },
        handshake: async () => {
          throw new Error('should not call handshake when api key is present');
        },
        request: async () => {
          throw new Error('should not request when api key is present');
        },
      });
      expect(result.status).toBe('authenticated');
      expect(result.message).toContain('Mistral API key');
    });
  });
});
