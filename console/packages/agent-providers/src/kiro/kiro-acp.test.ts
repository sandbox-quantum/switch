import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execProvider } from '../provider-process';
import { kiroAcp, parseKiroWhoami } from './kiro-acp';

vi.mock('../provider-process', () => ({
  execProvider: vi.fn(),
}));

describe('parseKiroWhoami', () => {
  it('reports an unparseable response as unknown', () => {
    expect(parseKiroWhoami('not valid json')).toMatchObject({
      status: 'unknown',
    });
  });

  it('reports an empty response as unknown', () => {
    expect(parseKiroWhoami('')).toMatchObject({
      status: 'unknown',
    });
  });

  it('reports the actual Kiro signed-out response as unauthenticated', () => {
    expect(parseKiroWhoami('{"account":null}')).toMatchObject({
      status: 'unauthenticated',
    });
  });

  it('reports the actual Kiro Google sign-in response as authenticated', () => {
    expect(
      parseKiroWhoami(
        JSON.stringify({
          accountType: 'SocialGoogle',
          provider: 'Google',
          email: 'test@example.com',
        })
      )
    ).toMatchObject({
      status: 'authenticated',
    });
  });

  it('does not treat arbitrary JSON strings as proof of authentication', () => {
    expect(parseKiroWhoami(JSON.stringify({ message: 'hello' }))).toMatchObject({
      status: 'unknown',
    });
  });

  it('reports an explicit signed-out response as unauthenticated', () => {
    expect(parseKiroWhoami(JSON.stringify({ status: 'not logged in' }))).toMatchObject({
      status: 'unauthenticated',
    });
  });

  it('reports a plain-text authentication error as unauthenticated', () => {
    expect(parseKiroWhoami('Authentication required')).toMatchObject({
      status: 'unauthenticated',
    });
  });

  it('uses Kiro V3 ACP launch arguments', () => {
    expect(
      kiroAcp.launch({
        binaryPath: 'kiro-cli',
        cwd: process.cwd(),
        env: {},
      })
    ).toMatchObject({
      command: 'kiro-cli',
      args: ['acp', '--agent-engine=v3'],
      env: {},
    });
  });

  it('uses Kiro CLI login instructions', () => {
    expect(kiroAcp.loginCommand).toBe('kiro-cli login');
  });
});

describe('kiroAcp.checkSignIn', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reports Kiro CLI as unconfigured when the executable is missing', async () => {
    vi.mocked(execProvider).mockRejectedValue(
      Object.assign(new Error('spawn kiro-cli ENOENT'), {
        code: 'ENOENT',
      })
    );

    const result = await kiroAcp.checkSignIn!({
      binaryPath: 'kiro-cli',
      cwd: process.cwd(),
      env: {},
      handshake: async () => {
        throw new Error('Handshake should not be called during sign-in check');
      },
    });

    expect(result.status).toBe('unconfigured');
  });

  it('detects authentication errors returned through stderr', async () => {
    vi.mocked(execProvider).mockRejectedValue(
      Object.assign(new Error('Command failed'), {
        code: 1,
        stdout: '',
        stderr: 'Authentication required',
      })
    );

    const result = await kiroAcp.checkSignIn!({
      binaryPath: 'kiro-cli',
      cwd: process.cwd(),
      env: {},
      handshake: async () => {
        throw new Error('Handshake should not be called during sign-in check');
      },
    });

    expect(result.status).toBe('unauthenticated');
  });
});
describe('kiroAcp.mcpServerOf', () => {
  it('returns the MCP server name from Kiro metadata', () => {
    expect(
      kiroAcp.mcpServerOf?.({
        toolCallId: 'call-1',
        _meta: {
          kiro: {
            serverName: 'echo',
            toolOrigin: 'default',
          },
        },
      })
    ).toBe('echo');
  });

  it('returns undefined when Kiro server metadata is missing', () => {
    expect(
      kiroAcp.mcpServerOf?.({
        toolCallId: 'call-2',
      })
    ).toBeUndefined();
  });
});
