import { describe, expect, it } from 'vitest';
import type { AcpInitializeResult } from '../acp/protocol';
import {
  createGrokBuildAdapter,
  grokBuildAcp,
  grokBuildSessionMode,
  GROK_BUILD_LOGIN,
} from './grok-build-acp';

describe('grokBuildAcp', () => {
  it('declares the conservative ACP provider contract', () => {
    expect(grokBuildAcp.provider).toBe('grok-build');
    expect(grokBuildAcp.label).toBe('Grok Build');
    expect(grokBuildAcp.defaultBinary).toBe('grok');
    expect(grokBuildAcp.loginCommand).toBe(GROK_BUILD_LOGIN);
    expect(grokBuildAcp.inheritEnv).toEqual(['XAI_API_KEY']);
    expect(grokBuildAcp.capabilities).toEqual({
      modelSwitchInSession: true,
      steering: false,
      resume: true,
      approvals: true,
      userInput: true,
    });
    expect(createGrokBuildAdapter).toBeTypeOf('function');
  });

  it('launches the verified ACP command with the supplied environment', () => {
    expect(
      grokBuildAcp.launch({
        binaryPath: '/usr/local/bin/grok',
        cwd: '/workspace',
        env: { XAI_API_KEY: 'test-key' },
      })
    ).toEqual({
      command: '/usr/local/bin/grok',
      args: ['--no-auto-update', 'agent', 'stdio'],
      env: { XAI_API_KEY: 'test-key' },
    });
  });

  it('routes mcp server tools correctly', () => {
    expect(
      grokBuildAcp.mcpServerOf?.({
        title: 'use_tool',
        rawInput: { tool_name: 'switch__read_file' },
      } as any)
    ).toBe('switch');
    expect(
      grokBuildAcp.mcpServerOf?.({
        title: 'switch__read_file',
        rawInput: {},
      } as any)
    ).toBe('switch');
  });

  it('recognizes subagent tasks', () => {
    expect(
      grokBuildAcp.itemType?.({
        title: 'spawn_subagent',
        rawInput: {},
      } as any)
    ).toBe('subagent');
    expect(
      grokBuildAcp.itemType?.({
        title: 'any_task',
        rawInput: { variant: 'Task' },
      } as any)
    ).toBe('subagent');
  });

  describe('checkSignIn', () => {
    const handshake = (result: Partial<AcpInitializeResult>) => async () =>
      result as AcpInitializeResult;
    const request = async <T>() => ({}) as T;

    it('trusts a non-empty API key without starting a handshake', async () => {
      const handshakeMock = async () => {
        throw new Error('handshake should not run');
      };
      const result = await grokBuildAcp.checkSignIn?.({
        binaryPath: 'grok',
        cwd: '/workspace',
        env: { XAI_API_KEY: ' test-key ' },
        handshake: handshakeMock,
        request,
      });
      expect(result?.status).toBe('authenticated');
    });

    it('recognizes the cached account method', async () => {
      const result = await grokBuildAcp.checkSignIn?.({
        binaryPath: 'grok',
        cwd: '/workspace',
        env: {},
        handshake: handshake({ authMethods: [{ id: 'cached_token', name: 'Cached account' }] }),
        request,
      });
      expect(result?.status).toBe('authenticated');
    });

    it('reports sign-in guidance for advertised login methods', async () => {
      const result = await grokBuildAcp.checkSignIn?.({
        binaryPath: 'grok',
        cwd: '/workspace',
        env: {},
        handshake: handshake({ authMethods: [{ id: 'grok.com', name: 'Grok account' }] }),
        request,
      });
      expect(result?.status).toBe('unauthenticated');
      expect(result?.message).toContain(GROK_BUILD_LOGIN);
    });

    it('does not claim authentication when the handshake is inconclusive', async () => {
      const result = await grokBuildAcp.checkSignIn?.({
        binaryPath: 'grok',
        cwd: '/workspace',
        env: {},
        handshake: handshake({}),
        request,
      });
      expect(result?.status).toBe('unknown');
    });

    it('keeps unexpected handshake failures unknown', async () => {
      const result = await grokBuildAcp.checkSignIn?.({
        binaryPath: 'grok',
        cwd: '/workspace',
        env: {},
        handshake: async () => {
          throw new Error('network unavailable');
        },
        request,
      });
      expect(result?.status).toBe('unknown');
    });
  });

  describe('session modes', () => {
    const modes = (ids: string[]) => ({ availableModes: ids.map((id) => ({ id, name: id })) });

    it('only selects modes advertised by Grok', () => {
      expect(grokBuildSessionMode('approval-required', modes(['ask', 'default']))).toBe('ask');
      expect(grokBuildSessionMode('full-access', modes(['always-approve']))).toBe('always-approve');
      expect(grokBuildSessionMode('auto', modes(['default']))).toBe('default');
    });

    it('leaves mode selection to the generic adapter when none match', () => {
      expect(grokBuildSessionMode('auto', modes(['plan']))).toBeUndefined();
      expect(grokBuildSessionMode('auto', undefined)).toBeUndefined();
    });
  });
});
