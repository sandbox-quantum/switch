import { describe, expect, it } from 'vitest';
import {
  checkJunieSignIn,
  JUNIE_LOGIN,
  junieAcp,
  junieSessionMode,
  parseJunieAuth,
} from './junie-acp';

describe('junieAcp', () => {
  it('defines provider hooks with expected launch and login commands', () => {
    expect(junieAcp.provider).toBe('junie');
    expect(junieAcp.label).toBe('Junie');
    expect(junieAcp.defaultBinary).toBe('junie');
    expect(junieAcp.loginCommand).toBe('junie login');
    expect(junieAcp.inheritEnv).toContain('JETBRAINS_TOKEN');
    expect(junieAcp.inheritEnv).toContain('JUNIE_API_KEY');

    const launchConfig = junieAcp.launch({
      binaryPath: '/usr/local/bin/junie',
      cwd: '/work',
      env: { JETBRAINS_TOKEN: 'test-key' },
    });
    expect(launchConfig).toEqual({
      command: '/usr/local/bin/junie',
      args: ['--acp'],
      env: { JETBRAINS_TOKEN: 'test-key' },
    });
  });

  describe('parseJunieAuth', () => {
    it('detects unauthenticated status when output mentions not logged in', () => {
      const result = parseJunieAuth('Error: user is not logged in. Please authenticate.');
      expect(result.status).toBe('unauthenticated');
      expect(result.message).toContain(JUNIE_LOGIN);
    });

    it('detects unauthenticated status when authentication is required', () => {
      const result = parseJunieAuth('Authentication required');
      expect(result.status).toBe('unauthenticated');
      expect(result.message).toContain(JUNIE_LOGIN);
    });

    it('detects authenticated status and extracts user email', () => {
      const result = parseJunieAuth('Account: dev@jetbrains.com (active)');
      expect(result.status).toBe('authenticated');
      expect(result.message).toContain('dev@jetbrains.com');
    });

    it('detects authenticated status with generic confirmation', () => {
      const result = parseJunieAuth('JetBrains Junie authentication status: ok');
      expect(result.status).toBe('authenticated');
    });
  });

  describe('junieSessionMode', () => {
    const modes = {
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'ask', name: 'Ask' },
        { id: 'accept-edits', name: 'Accept edits' },
        { id: 'auto-approve', name: 'Auto approve' },
      ],
      currentMode: 'default',
    };

    it('maps runtime modes to the preferred Junie ACP mode', () => {
      expect(junieSessionMode('full-access', modes)).toBe('auto-approve');
      expect(junieSessionMode('auto-accept-edits', modes)).toBe('accept-edits');
      expect(junieSessionMode('auto', modes)).toBe('accept-edits');
      expect(junieSessionMode('approval-required', modes)).toBe('ask');
    });

    it('returns undefined if modes are not provided', () => {
      expect(junieSessionMode('full-access', undefined)).toBeUndefined();
    });
  });

  describe('checkJunieSignIn', () => {
    it('returns authenticated immediately when JETBRAINS_TOKEN is provided in env', async () => {
      const result = await checkJunieSignIn({
        binaryPath: 'junie',
        cwd: '/work',
        env: { JETBRAINS_TOKEN: 'test-secret-token' },
        handshake: async () => {
          throw new Error('should not call handshake when token is present');
        },
        request: async () => {
          throw new Error('should not request when token is present');
        },
      });
      expect(result.status).toBe('authenticated');
      expect(result.message).toContain('JetBrains token');
    });

    it('returns authenticated immediately when JUNIE_API_KEY is provided in env', async () => {
      const result = await checkJunieSignIn({
        binaryPath: 'junie',
        cwd: '/work',
        env: { JUNIE_API_KEY: 'test-junie-key' },
        handshake: async () => {
          throw new Error('should not call handshake when token is present');
        },
        request: async () => {
          throw new Error('should not request when token is present');
        },
      });
      expect(result.status).toBe('authenticated');
      expect(result.message).toContain('JetBrains token');
    });
  });
});
