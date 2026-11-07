import { describe, expect, it, vi } from 'vitest';
import type { AcpInitializeResult } from '../acp/protocol';
import { JUNIE_LOGIN, junieAcp } from './junie-adapter';

const FAKE_INITIALIZE: AcpInitializeResult = {
  protocolVersion: 1,
  agentInfo: { name: 'junie', version: '1.0.0' },
};

describe('junieAcp hooks', () => {
  it('configures launch command with --acp=true and preserves environment', () => {
    const launch = junieAcp.launch({
      binaryPath: '/path/to/junie',
      cwd: '/workspace',
      env: { CUSTOM_VAR: 'val' },
    });
    expect(launch).toEqual({
      command: '/path/to/junie',
      args: ['--acp=true'],
      env: { CUSTOM_VAR: 'val' },
    });
  });

  it('exposes junie login as loginCommand', () => {
    expect(junieAcp.loginCommand).toBe('junie login');
    expect(JUNIE_LOGIN).toBe('junie login');
  });

  describe('checkSignIn', () => {
    it('detects authentication when JUNIE_API_KEY is present', async () => {
      const result = await junieAcp.checkSignIn!({
        binaryPath: 'junie',
        cwd: '/workspace',
        env: { JUNIE_API_KEY: 'test-key' },
        handshake: vi.fn(),
        request: vi.fn(),
      });
      expect(result).toEqual({
        status: 'authenticated',
        message: 'Signs in with the API key it was given.',
      });
    });

    it('detects authentication when OPENAI_API_KEY is present', async () => {
      const result = await junieAcp.checkSignIn!({
        binaryPath: 'junie',
        cwd: '/workspace',
        env: { OPENAI_API_KEY: 'sk-test' },
        handshake: vi.fn(),
        request: vi.fn(),
      });
      expect(result).toEqual({
        status: 'authenticated',
        message: 'Signs in with the API key it was given.',
      });
    });

    it('detects authentication when ANTHROPIC_API_KEY is present', async () => {
      const result = await junieAcp.checkSignIn!({
        binaryPath: 'junie',
        cwd: '/workspace',
        env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
        handshake: vi.fn(),
        request: vi.fn(),
      });
      expect(result).toEqual({
        status: 'authenticated',
        message: 'Signs in with the API key it was given.',
      });
    });

    it('probes non-interactively via handshake and request when no API key is provided', async () => {
      const handshake = vi.fn().mockResolvedValue(FAKE_INITIALIZE);
      const request = vi.fn().mockResolvedValue({ sessionId: 's-1' });

      const result = await junieAcp.checkSignIn!({
        binaryPath: 'junie',
        cwd: '/workspace',
        env: {},
        handshake,
        request,
      });

      expect(handshake).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith('session/new', { cwd: '/workspace', mcpServers: [] });
      expect(result).toEqual({
        status: 'authenticated',
        message: 'Signed in.',
      });
    });

    it('reports unauthenticated when probe fails with authentication error', async () => {
      const handshake = vi.fn().mockResolvedValue(FAKE_INITIALIZE);
      const request = vi.fn().mockRejectedValue(new Error('Authentication required'));

      const result = await junieAcp.checkSignIn!({
        binaryPath: 'junie',
        cwd: '/workspace',
        env: {},
        handshake,
        request,
      });

      expect(result.status).toBe('unauthenticated');
      expect(result.message).toContain('junie login');
    });

    it('reports unknown readiness when probe fails with connection error', async () => {
      const handshake = vi.fn().mockRejectedValue(new Error('Process exited unexpectedly with code 1'));
      const request = vi.fn();

      const result = await junieAcp.checkSignIn!({
        binaryPath: 'junie',
        cwd: '/workspace',
        env: {},
        handshake,
        request,
      });

      expect(result.status).toBe('unknown');
    });
  });

  describe('mcpServerOf', () => {
    it('extracts server name from providerIdentifier raw input', () => {
      expect(
        junieAcp.mcpServerOf!({
          toolCallId: 'call-1',
          rawInput: { providerIdentifier: 'weather_service' },
        })
      ).toBe('weather_service');
    });

    it('extracts server name from double underscore prefix in title', () => {
      expect(
        junieAcp.mcpServerOf!({
          toolCallId: 'call-2',
          title: 'github__create_issue: repo/issue',
        })
      ).toBe('github');
    });

    it('returns undefined when no server attribution is present', () => {
      expect(
        junieAcp.mcpServerOf!({
          toolCallId: 'call-3',
          title: 'run_command',
        })
      ).toBeUndefined();
    });
  });

  describe('itemType', () => {
    it('detects task tool call as subagent', () => {
      expect(
        junieAcp.itemType!({
          toolCallId: 'c1',
          rawInput: { _toolName: 'task' },
        })
      ).toBe('subagent');

      expect(
        junieAcp.itemType!({
          toolCallId: 'c2',
          title: 'Task: run subtask',
        })
      ).toBe('subagent');

      expect(
        junieAcp.itemType!({
          toolCallId: 'c3',
          title: 'spawn_agent: delegate',
        })
      ).toBe('subagent');
    });

    it('returns undefined for normal tool calls', () => {
      expect(
        junieAcp.itemType!({
          toolCallId: 'c4',
          title: 'run_command: ls',
        })
      ).toBeUndefined();
    });
  });
});
