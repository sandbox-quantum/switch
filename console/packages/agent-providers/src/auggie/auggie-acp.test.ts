import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execProvider } from '../provider-process';
import { auggieAcp, AUGGIE_LOGIN, parseAuggieAuthStatus } from './auggie-acp';

vi.mock('../provider-process', () => ({
  execProvider: vi.fn(),
}));

describe('parseAuggieAuthStatus', () => {
  it('reports an empty response as unknown', () => {
    expect(parseAuggieAuthStatus('')).toMatchObject({ status: 'unknown' });
  });

  it('reports an unexpected response as unknown', () => {
    expect(parseAuggieAuthStatus('Authentication status unavailable')).toMatchObject({
      status: 'unknown',
    });
  });

  it('reports the actual Auggie signed-out response as unauthenticated', () => {
    expect(parseAuggieAuthStatus('Not logged in.')).toMatchObject({
      status: 'unauthenticated',
    });
  });

  it('reports the actual Auggie signed-in response as authenticated', () => {
    expect(parseAuggieAuthStatus('Logged in.')).toMatchObject({
      status: 'authenticated',
    });
  });

  it('uses Auggie ACP launch arguments', () => {
    expect(
      auggieAcp.launch({
        binaryPath: 'auggie',
        cwd: process.cwd(),
        env: {},
      })
    ).toMatchObject({
      command: 'auggie',
      args: ['--acp'],
      env: {},
    });
  });

  it('uses Auggie CLI login instructions', () => {
    expect(auggieAcp.loginCommand).toBe(AUGGIE_LOGIN);
    expect(AUGGIE_LOGIN).toBe('auggie auth login');
  });

  it('declares image prompt support from the ACP handshake', () => {
    expect(auggieAcp.promptCapabilities).toEqual({ image: true });
  });
});

describe('auggieAcp.checkSignIn', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('checks authentication without starting a login flow', async () => {
    vi.mocked(execProvider).mockResolvedValue({
      stdout: 'Logged in.',
      stderr: '',
    });

    const result = await auggieAcp.checkSignIn!({
      binaryPath: 'auggie',
      cwd: process.cwd(),
      env: {},
      handshake: async () => {
        throw new Error('Handshake should not be called during sign-in check');
      },
    });

    expect(result.status).toBe('authenticated');
    expect(execProvider).toHaveBeenCalledWith(
      'auggie',
      ['auth', 'status'],
      expect.objectContaining({ cwd: process.cwd(), env: {} })
    );
  });

  it('detects signed-out status from stderr', async () => {
    vi.mocked(execProvider).mockRejectedValue(
      Object.assign(new Error('Command failed'), {
        code: 1,
        stdout: '',
        stderr: 'Not logged in.',
      })
    );

    const result = await auggieAcp.checkSignIn!({
      binaryPath: 'auggie',
      cwd: process.cwd(),
      env: {},
      handshake: async () => {
        throw new Error('Handshake should not be called during sign-in check');
      },
    });

    expect(result.status).toBe('unauthenticated');
  });

  it('reports Auggie CLI as unconfigured when the executable is missing', async () => {
    vi.mocked(execProvider).mockRejectedValue(
      Object.assign(new Error('spawn auggie ENOENT'), {
        code: 'ENOENT',
      })
    );

    const result = await auggieAcp.checkSignIn!({
      binaryPath: 'auggie',
      cwd: process.cwd(),
      env: {},
      handshake: async () => {
        throw new Error('Handshake should not be called during sign-in check');
      },
    });

    expect(result.status).toBe('unconfigured');
  });
});
