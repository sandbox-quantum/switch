import type * as FsModule from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectSshAuthSock } from './shellEnv';

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn<(p: string) => boolean>(),
  statSync: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, existsSync: mocks.existsSync, statSync: mocks.statSync };
});

const WINDOWS_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalEnv = { ...process.env };

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  process.env = { ...originalEnv };
  vi.clearAllMocks();
});

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('detectSshAuthSock on Windows', () => {
  it('returns the OpenSSH named pipe, which is not a socket to statSync', () => {
    setPlatform('win32');
    delete process.env.SSH_AUTH_SOCK;
    mocks.existsSync.mockImplementation((p) => p === WINDOWS_AGENT_PIPE);

    expect(detectSshAuthSock()).toBe(WINDOWS_AGENT_PIPE);
  });

  it('returns undefined when the agent pipe is absent, without globbing POSIX paths', () => {
    setPlatform('win32');
    delete process.env.SSH_AUTH_SOCK;
    mocks.existsSync.mockReturnValue(false);

    expect(detectSshAuthSock()).toBeUndefined();
    expect(mocks.statSync).not.toHaveBeenCalled();
  });

  it('still prefers an inherited SSH_AUTH_SOCK', () => {
    setPlatform('win32');
    process.env.SSH_AUTH_SOCK = '\\\\.\\pipe\\custom-agent';

    expect(detectSshAuthSock()).toBe('\\\\.\\pipe\\custom-agent');
    expect(mocks.existsSync).not.toHaveBeenCalled();
  });
});
