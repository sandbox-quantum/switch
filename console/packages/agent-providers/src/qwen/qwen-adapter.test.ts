import { describe, expect, it, vi } from 'vitest';
import { qwenAcp } from './qwen-adapter';

describe('Qwen ACP provider hooks', () => {
  it('registers Qwen Code with the correct provider identity', () => {
    expect(qwenAcp.provider).toBe('qwen');
    expect(qwenAcp.label).toBe('Qwen Code');
    expect(qwenAcp.defaultBinary).toBe('qwen');
  });
  it('propagates ACP handshake failures', async () => {
    const error = new Error('Qwen CLI failed to start');

    await expect(
      qwenAcp.checkSignIn!({
        binaryPath: 'qwen',
        cwd: '/work',
        env: {},
        handshake: vi.fn().mockRejectedValue(error),
      })
    ).rejects.toThrow('Qwen CLI failed to start');
  });
  it('launches Qwen in ACP mode', () => {
    const env = { PATH: '/usr/bin' };

    expect(qwenAcp.launch({ binaryPath: 'qwen', cwd: '/work', env })).toEqual({
      command: 'qwen',
      args: ['--acp'],
      env,
    });
  });

  it('maps Switch runtime modes to Qwen approval modes', () => {
    expect(qwenAcp.sessionMode?.('approval-required')).toBe('default');
    expect(qwenAcp.sessionMode?.('auto-accept-edits')).toBe('auto-edit');
    expect(qwenAcp.sessionMode?.('auto')).toBe('auto');
    expect(qwenAcp.sessionMode?.('full-access')).toBe('yolo');
  });

  it('declares the supported prompt capabilities', () => {
    expect(qwenAcp.promptCapabilities).toEqual({
      image: true,
      audio: true,
      embeddedContext: true,
    });
  });
  it('declares Qwen ACP session capabilities', () => {
    expect(qwenAcp.capabilities).toEqual({
      modelSwitchInSession: true,
      steering: false,
      resume: true,
      approvals: true,
      userInput: false,
    });
  });
  it('does not assume unauthenticated from advertised auth methods', async () => {
    const result = await qwenAcp.checkSignIn!({
      handshake: async () => ({
        authMethods: [{ id: 'openai', name: 'Use OpenAI API key' }],
      }),
    } as any);

    expect(result.status).toBe('unknown');
    expect(result.message).toContain('authentication status could not be confirmed');
  });

  it('does not assume authenticated when no auth methods are advertised', async () => {
    const result = await qwenAcp.checkSignIn!({
      binaryPath: 'qwen',
      cwd: '/work',
      env: {},
      handshake: vi.fn().mockResolvedValue({
        authMethods: [],
      }),
    });

    expect(result.status).toBe('unknown');
  });

  it('does not authenticate during readiness checks', async () => {
    const handshake = vi.fn().mockResolvedValue({
      authMethods: [{ id: 'openai', name: 'Use OpenAI API key' }],
    });

    await qwenAcp.checkSignIn!({
      binaryPath: 'qwen',
      cwd: '/work',
      env: {},
      handshake,
    });

    expect(handshake).toHaveBeenCalledTimes(1);
  });
  it('uses a Qwen-specific native session ID prefix', () => {
    expect(qwenAcp.nativeSessionIdPrefix).toEqual({
      prefix: 'acp:qwen:',
      legacyMessage:
        'This conversation belongs to the previous Qwen runtime. Start a fresh ACP conversation; the existing transcript is preserved.',
    });
  });
});
