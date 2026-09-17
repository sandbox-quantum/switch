import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import { createSshInstallCommandRunner } from './ssh-install-runner';

vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
vi.mock('@main/core/ssh/lifecycle/remote-shell-profile', () => ({
  buildRemoteShellCommand: (_profile: unknown, command: string) => command,
}));

describe('SSH installer', () => {
  it('streams stdout and stderr through a plain exec channel and reports failure', async () => {
    const channel = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      end: vi.fn(),
      close: vi.fn(),
      signal: vi.fn(),
    });
    const exec = vi.fn((_command, callback) => {
      callback(null, channel);
      queueMicrotask(() => {
        channel.emit('data', Buffer.from('installing\n'));
        channel.stderr.emit('data', Buffer.from('permission denied'));
        channel.emit('close', 13);
      });
    });
    const proxy = { getRemoteShellProfile: async () => ({}), exec } as unknown as SshClientProxy;
    const output = vi.fn();
    const result = await createSshInstallCommandRunner(
      proxy,
      output
    )({ command: 'tool', args: ['a; b'] });
    expect(exec.mock.calls[0][0]).toBe("'tool' 'a; b'");
    expect(output).toHaveBeenCalledWith('permission denied');
    expect(channel.end).toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      error: { type: 'permission-denied', exitCode: 13 },
    });
  });
});
