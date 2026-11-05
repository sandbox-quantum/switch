import { describe, expect, it, vi } from 'vitest';
import type { AcpInitializeResult } from '../acp/protocol';
import { COPILOT_LOGIN, copilotAcp, createCopilotAdapter } from './copilot-adapter';

describe('copilotAcp', () => {
  it('exposes the expected metadata and capabilities', () => {
    expect(copilotAcp.provider).toBe('copilot');
    expect(copilotAcp.label).toBe('GitHub Copilot');
    expect(copilotAcp.defaultBinary).toBe('copilot');
    expect(copilotAcp.loginCommand).toBe(COPILOT_LOGIN);
    expect(copilotAcp.loginCommand).toBe('copilot login');
    expect(copilotAcp.capabilities).toEqual({
      modelSwitchInSession: true,
      steering: false,
      resume: true,
      approvals: true,
      userInput: false,
    });
    expect(copilotAcp.promptCapabilities).toEqual({ image: true });
    expect(copilotAcp.inheritEnv).toContain('COPILOT_GITHUB_TOKEN');
    expect(copilotAcp.inheritEnv).toContain('GH_TOKEN');
    expect(copilotAcp.inheritEnv).toContain('GITHUB_TOKEN');
    expect(copilotAcp.inheritEnv).toContain('COPILOT_PROVIDERS_CONFIG');
  });

  it('configures launch command and stdio ACP arguments', () => {
    const launch = copilotAcp.launch({
      binaryPath: 'copilot',
      cwd: '/test/workspace',
      env: { TEST_ENV: '1' },
    });
    expect(launch).toEqual({
      command: 'copilot',
      args: ['--acp', '--stdio'],
      env: { TEST_ENV: '1' },
    });
  });

  describe('checkSignIn', () => {
    const baseInput = {
      binaryPath: 'copilot',
      cwd: '/test/workspace',
    };

    it('reports authenticated when COPILOT_GITHUB_TOKEN is in environment', async () => {
      const handshake = vi.fn();
      const result = await copilotAcp.checkSignIn!({
        ...baseInput,
        env: { COPILOT_GITHUB_TOKEN: 'ghp_token123' },
        handshake,
      });
      expect(result.status).toBe('authenticated');
      expect(result.message).toContain('token or provider configuration');
      expect(handshake).not.toHaveBeenCalled();
    });

    it('reports authenticated when GH_TOKEN is in environment', async () => {
      const handshake = vi.fn();
      const result = await copilotAcp.checkSignIn!({
        ...baseInput,
        env: { GH_TOKEN: 'gho_token123' },
        handshake,
      });
      expect(result.status).toBe('authenticated');
      expect(handshake).not.toHaveBeenCalled();
    });

    it('reports authenticated when GITHUB_TOKEN is in environment', async () => {
      const handshake = vi.fn();
      const result = await copilotAcp.checkSignIn!({
        ...baseInput,
        env: { GITHUB_TOKEN: 'github_pat_123' },
        handshake,
      });
      expect(result.status).toBe('authenticated');
      expect(handshake).not.toHaveBeenCalled();
    });

    it('reports authenticated when COPILOT_PROVIDERS_CONFIG is in environment', async () => {
      const handshake = vi.fn();
      const result = await copilotAcp.checkSignIn!({
        ...baseInput,
        env: { COPILOT_PROVIDERS_CONFIG: '{"provider":"custom"}' },
        handshake,
      });
      expect(result.status).toBe('authenticated');
      expect(handshake).not.toHaveBeenCalled();
    });

    it('reports authenticated when a COPILOT_PROVIDER_* key is in environment', async () => {
      const handshake = vi.fn();
      const result = await copilotAcp.checkSignIn!({
        ...baseInput,
        env: { COPILOT_PROVIDER_ANTHROPIC_KEY: 'sk-ant-test' },
        handshake,
      });
      expect(result.status).toBe('authenticated');
      expect(handshake).not.toHaveBeenCalled();
    });

    it('reports unauthenticated when no credentials exist in environment or config', async () => {
      const handshake = vi.fn().mockResolvedValue({
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [{ id: 'copilot-login', name: 'Copilot Login' }],
      } as AcpInitializeResult);
      const result = await copilotAcp.checkSignIn!({
        ...baseInput,
        env: { COPILOT_HOME: '/nonexistent-copilot-home' },
        handshake,
      });
      expect(result.status).toBe('unauthenticated');
      expect(result.message).toContain('copilot login');
      expect(handshake).toHaveBeenCalled();
    });

    it('reports authenticated when copilot config has a logged-in user', async () => {
      const handshake = vi.fn().mockResolvedValue({
        protocolVersion: 1,
        agentCapabilities: {},
      } as AcpInitializeResult);
      const result = await copilotAcp.checkSignIn!({
        ...baseInput,
        env: {},
        handshake,
      });
      expect(result.status).toBe('authenticated');
      expect(result.message).toContain('Signed in to GitHub Copilot CLI');
    });

    it('reports unauthenticated when handshake throws an authentication error', async () => {
      const handshake = vi.fn().mockRejectedValue(new Error('Login required to access Copilot'));
      const result = await copilotAcp.checkSignIn!({
        ...baseInput,
        env: { COPILOT_HOME: '/nonexistent-copilot-home' },
        handshake,
      });
      expect(result.status).toBe('unauthenticated');
      expect(result.message).toContain('copilot login');
    });

    it('rethrows unexpected errors from handshake', async () => {
      const handshake = vi
        .fn()
        .mockRejectedValue(new Error('Connection unexpectedly reset by peer'));
      await expect(
        copilotAcp.checkSignIn!({
          ...baseInput,
          env: {},
          handshake,
        })
      ).rejects.toThrow('Connection unexpectedly reset by peer');
    });
  });

  it('creates an ACP adapter using createCopilotAdapter', () => {
    const adapter = createCopilotAdapter();
    expect(adapter).toBeDefined();
    expect(typeof adapter.startSession).toBe('function');
  });
});
