import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RemoteShellProfileModule from './remote-shell-profile';
import { SshClientProxy } from './ssh-client-proxy';

const mocks = vi.hoisted(() => ({
  captureRemoteShellProfile: vi.fn(),
}));

vi.mock('./remote-shell-profile', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof RemoteShellProfileModule;
  return {
    ...actual,
    captureRemoteShellProfile: mocks.captureRemoteShellProfile,
  };
});

describe('SshClientProxy remote shell profile', () => {
  beforeEach(() => {
    mocks.captureRemoteShellProfile.mockReset();
  });

  it('returns a rejected promise when the SSH connection is unavailable', async () => {
    const proxy = new SshClientProxy('ssh-1');

    await expect(proxy.getRemoteShellProfile()).rejects.toThrow('SSH connection is not available');
  });

  it('captures and caches the remote shell profile behind the proxy API', async () => {
    const client = {};
    const profile = {
      shell: '/bin/zsh',
      env: { PATH: '/opt/homebrew/bin:/usr/bin' },
    };
    mocks.captureRemoteShellProfile.mockResolvedValue(profile);
    const proxy = new SshClientProxy('ssh-1');
    proxy.update(client as never);

    await expect(proxy.getRemoteShellProfile()).resolves.toBe(profile);
    await expect(proxy.getRemoteShellProfile()).resolves.toBe(profile);

    expect(mocks.captureRemoteShellProfile).toHaveBeenCalledTimes(1);
    expect(mocks.captureRemoteShellProfile).toHaveBeenCalledWith(proxy);
  });

  it('does not cache an in-flight shell profile after invalidation', async () => {
    let resolveFirst!: (profile: { shell: string; env: Record<string, string> }) => void;
    const firstCapture = new Promise<{ shell: string; env: Record<string, string> }>((resolve) => {
      resolveFirst = resolve;
    });
    const firstClient = {};
    const secondClient = {};
    mocks.captureRemoteShellProfile
      .mockReturnValueOnce(firstCapture)
      .mockResolvedValueOnce({ shell: '/bin/bash', env: { PATH: '/second' } });
    const proxy = new SshClientProxy('ssh-1');

    proxy.update(firstClient as never);
    const staleCapture = proxy.getRemoteShellProfile();
    proxy.invalidate();
    proxy.update(secondClient as never);
    resolveFirst({ shell: '/bin/zsh', env: { PATH: '/first' } });
    await staleCapture;

    await expect(proxy.getRemoteShellProfile()).resolves.toEqual({
      shell: '/bin/bash',
      env: { PATH: '/second' },
    });
    expect(mocks.captureRemoteShellProfile).toHaveBeenCalledTimes(2);
    expect(mocks.captureRemoteShellProfile).toHaveBeenNthCalledWith(2, proxy);
  });

  it('clears cached shell profile on invalidate', async () => {
    const firstClient = {};
    const secondClient = {};
    mocks.captureRemoteShellProfile
      .mockResolvedValueOnce({ shell: '/bin/zsh', env: { PATH: '/first' } })
      .mockResolvedValueOnce({ shell: '/bin/bash', env: { PATH: '/second' } });
    const proxy = new SshClientProxy('ssh-1');

    proxy.update(firstClient as never);
    await proxy.getRemoteShellProfile();
    proxy.invalidate();
    proxy.update(secondClient as never);
    const profile = await proxy.getRemoteShellProfile();

    expect(profile).toEqual({ shell: '/bin/bash', env: { PATH: '/second' } });
    expect(mocks.captureRemoteShellProfile).toHaveBeenCalledTimes(2);
  });

  it('recaptures the remote shell profile on explicit refresh', async () => {
    const client = {};
    mocks.captureRemoteShellProfile
      .mockResolvedValueOnce({ shell: '/bin/zsh', env: { PATH: '/old' } })
      .mockResolvedValueOnce({ shell: '/bin/zsh', env: { PATH: '/new:/usr/bin' } });
    const proxy = new SshClientProxy('ssh-1');
    proxy.update(client as never);

    await expect(proxy.getRemoteShellProfile()).resolves.toEqual({
      shell: '/bin/zsh',
      env: { PATH: '/old' },
    });
    await expect(proxy.refreshRemoteShellProfile()).resolves.toEqual({
      shell: '/bin/zsh',
      env: { PATH: '/new:/usr/bin' },
    });
    await expect(proxy.getRemoteShellProfile()).resolves.toEqual({
      shell: '/bin/zsh',
      env: { PATH: '/new:/usr/bin' },
    });
    expect(mocks.captureRemoteShellProfile).toHaveBeenCalledTimes(2);
  });

  it('deduplicates get calls while a refresh is in flight', async () => {
    let resolveRefresh!: (profile: { shell: string; env: Record<string, string> }) => void;
    const refreshCapture = new Promise<{ shell: string; env: Record<string, string> }>(
      (resolve) => {
        resolveRefresh = resolve;
      }
    );
    const client = {};
    mocks.captureRemoteShellProfile.mockReturnValueOnce(refreshCapture);
    const proxy = new SshClientProxy('ssh-1');
    proxy.update(client as never);

    const refresh = proxy.refreshRemoteShellProfile();
    const concurrentGet = proxy.getRemoteShellProfile();
    resolveRefresh({ shell: '/bin/zsh', env: { PATH: '/refreshed:/usr/bin' } });

    await expect(refresh).resolves.toEqual({
      shell: '/bin/zsh',
      env: { PATH: '/refreshed:/usr/bin' },
    });
    await expect(concurrentGet).resolves.toEqual({
      shell: '/bin/zsh',
      env: { PATH: '/refreshed:/usr/bin' },
    });
    expect(mocks.captureRemoteShellProfile).toHaveBeenCalledTimes(1);
    await expect(proxy.getRemoteShellProfile()).resolves.toEqual({
      shell: '/bin/zsh',
      env: { PATH: '/refreshed:/usr/bin' },
    });
    expect(mocks.captureRemoteShellProfile).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent refreshes for the same client', async () => {
    let resolveRefresh!: (profile: { shell: string; env: Record<string, string> }) => void;
    const refreshCapture = new Promise<{ shell: string; env: Record<string, string> }>(
      (resolve) => {
        resolveRefresh = resolve;
      }
    );
    const client = {};
    mocks.captureRemoteShellProfile.mockReturnValueOnce(refreshCapture);
    const proxy = new SshClientProxy('ssh-1');
    proxy.update(client as never);

    const first = proxy.refreshRemoteShellProfile();
    const second = proxy.refreshRemoteShellProfile();
    resolveRefresh({ shell: '/bin/zsh', env: { PATH: '/refreshed:/usr/bin' } });

    await expect(first).resolves.toEqual({
      shell: '/bin/zsh',
      env: { PATH: '/refreshed:/usr/bin' },
    });
    await expect(second).resolves.toEqual({
      shell: '/bin/zsh',
      env: { PATH: '/refreshed:/usr/bin' },
    });
    expect(mocks.captureRemoteShellProfile).toHaveBeenCalledTimes(1);
  });

  it('lets refresh preempt an in-flight get capture', async () => {
    let resolveGet!: (profile: { shell: string; env: Record<string, string> }) => void;
    let resolveRefresh!: (profile: { shell: string; env: Record<string, string> }) => void;
    const getCapture = new Promise<{ shell: string; env: Record<string, string> }>((resolve) => {
      resolveGet = resolve;
    });
    const refreshCapture = new Promise<{ shell: string; env: Record<string, string> }>(
      (resolve) => {
        resolveRefresh = resolve;
      }
    );
    const client = {};
    mocks.captureRemoteShellProfile
      .mockReturnValueOnce(getCapture)
      .mockReturnValueOnce(refreshCapture);
    const proxy = new SshClientProxy('ssh-1');
    proxy.update(client as never);

    const staleGet = proxy.getRemoteShellProfile();
    const refresh = proxy.refreshRemoteShellProfile();
    resolveGet({ shell: '/bin/zsh', env: { PATH: '/old' } });
    resolveRefresh({ shell: '/bin/zsh', env: { PATH: '/new:/usr/bin' } });

    await expect(staleGet).resolves.toEqual({ shell: '/bin/zsh', env: { PATH: '/old' } });
    await expect(refresh).resolves.toEqual({
      shell: '/bin/zsh',
      env: { PATH: '/new:/usr/bin' },
    });
    await expect(proxy.getRemoteShellProfile()).resolves.toEqual({
      shell: '/bin/zsh',
      env: { PATH: '/new:/usr/bin' },
    });
    expect(mocks.captureRemoteShellProfile).toHaveBeenCalledTimes(2);
  });
});

describe('SshClientProxy exec semaphore', () => {
  it('fails queued execs and resets slots on invalidate', () => {
    // Four execs whose channel-open callback never fires occupy every slot;
    // the fifth queues. Before the fix the queue starved forever — even after
    // a successful reconnect — because the leaked slots were never reset.
    const client = { exec: vi.fn() }; // never invokes the callback
    const proxy = new SshClientProxy('ssh-1');
    proxy.update(client as never);

    const callbacks = Array.from({ length: 5 }, () => vi.fn());
    for (const cb of callbacks) proxy.exec('sleep 999', cb);
    expect(client.exec).toHaveBeenCalledTimes(4); // fifth is queued

    proxy.invalidate();

    // The queued exec fails immediately with a connection error.
    expect(callbacks[4]).toHaveBeenCalledTimes(1);
    expect(String(callbacks[4]!.mock.calls[0]![0])).toContain('SSH connection is not available');

    // After reconnect, slots are free again: new execs run immediately.
    const freshClient = { exec: vi.fn((_c: string, cb: (e?: Error) => void) => cb(undefined)) };
    proxy.update(freshClient as never);
    const postReconnect = vi.fn();
    proxy.exec('true', postReconnect);
    expect(freshClient.exec).toHaveBeenCalledTimes(1);
    expect(postReconnect).toHaveBeenCalled();
  });

  it('does not drive the slot counter negative when dead channels close late', () => {
    let closeHandler: (() => void) | undefined;
    const channel = {
      once: vi.fn((event: string, handler: () => void) => {
        if (event === 'close') closeHandler = handler;
      }),
    };
    const client = {
      exec: vi.fn((_c: string, cb: (e?: Error, ch?: unknown) => void) => cb(undefined, channel)),
    };
    const proxy = new SshClientProxy('ssh-1');
    proxy.update(client as never);

    proxy.exec('true', vi.fn());
    proxy.invalidate(); // resets the counter while the channel is still open
    closeHandler?.(); // straggling close from the dead client

    // Occupy slots without completing, so the cap is observable.
    const freshClient = { exec: vi.fn() };
    proxy.update(freshClient as never);
    for (let i = 0; i < 5; i++) proxy.exec('true', vi.fn());
    // With a negative counter this would admit more than the 4-slot cap.
    expect(freshClient.exec).toHaveBeenCalledTimes(4);
  });
});

describe('SshClientProxy channel open timeouts', () => {
  it('times out an exec channel open, frees the slot, and reports the failure', async () => {
    vi.useFakeTimers();
    try {
      const reporter = { reportChannelError: vi.fn(), reportChannelSuccess: vi.fn() };
      const client = { exec: vi.fn() }; // open never answered
      const proxy = new SshClientProxy('ssh-1', reporter);
      proxy.update(client as never);

      const callback = vi.fn();
      proxy.exec('true', callback);
      expect(callback).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(15_000);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(String(callback.mock.calls[0]![0])).toContain('channel open timed out');
      expect(reporter.reportChannelError).toHaveBeenCalledWith('ssh-1', expect.any(Error));

      // The slot freed by the timeout admits the next exec immediately.
      proxy.exec('true', vi.fn());
      expect(client.exec).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a forwardOut whose open is never answered', async () => {
    vi.useFakeTimers();
    try {
      const reporter = { reportChannelError: vi.fn() };
      const client = { forwardOut: vi.fn() }; // open never answered
      const proxy = new SshClientProxy('ssh-1', reporter);
      proxy.update(client as never);

      const pending = proxy.forwardOut(4321);
      const assertion = expect(pending).rejects.toThrow('channel open timed out');
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(reporter.reportChannelError).toHaveBeenCalledWith('ssh-1', expect.any(Error));
    } finally {
      vi.useRealTimers();
    }
  });

  it('destroys a channel delivered after the open deadline', async () => {
    vi.useFakeTimers();
    try {
      let lateCallback: ((err: Error | undefined, ch: unknown) => void) | undefined;
      const client = {
        forwardOut: vi.fn((_sip, _sport, _dip, _dport, cb) => {
          lateCallback = cb;
        }),
      };
      const proxy = new SshClientProxy('ssh-1');
      proxy.update(client as never);

      const pending = proxy.forwardOut(4321);
      const assertion = expect(pending).rejects.toThrow('channel open timed out');
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;

      const channel = { destroy: vi.fn() };
      lateCallback?.(undefined, channel);
      expect(channel.destroy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports channel successes so the manager can clear failure streaks', () => {
    const reporter = { reportChannelError: vi.fn(), reportChannelSuccess: vi.fn() };
    const client = {
      forwardOut: vi.fn((_sip, _sport, _dip, _dport, cb) => cb(undefined, { id: 'chan' })),
    };
    const proxy = new SshClientProxy('ssh-1', reporter);
    proxy.update(client as never);

    void proxy.forwardOut(4321);

    expect(reporter.reportChannelSuccess).toHaveBeenCalledWith('ssh-1');
    expect(reporter.reportChannelError).not.toHaveBeenCalled();
  });
});

describe('SshClientProxy channel health reporting', () => {
  it('reports exec channel success and failure', () => {
    const successCallback = vi.fn();
    const error = new Error('open failed');
    const reporter = {
      reportChannelError: vi.fn(),
    };
    const client = {
      exec: vi
        .fn()
        .mockImplementationOnce((_command, callback) => callback(undefined, {}))
        .mockImplementationOnce((_command, callback) => callback(error, undefined)),
    };
    const proxy = new SshClientProxy('ssh-1', reporter);
    proxy.update(client as never);

    proxy.exec('true', successCallback);
    proxy.exec('false', vi.fn());

    expect(successCallback).toHaveBeenCalledWith(undefined, {});
    expect(reporter.reportChannelError).toHaveBeenCalledWith('ssh-1', error);
  });

  it('forwards a tcpip channel to the remote loopback and reports failures', async () => {
    const channel = { id: 'chan' };
    const forwardError = new Error('forward failed');
    const reporter = { reportChannelError: vi.fn() };
    const client = {
      forwardOut: vi
        .fn()
        .mockImplementationOnce((_sip, _sport, _dip, _dport, cb) => cb(undefined, channel))
        .mockImplementationOnce((_sip, _sport, _dip, _dport, cb) => cb(forwardError, undefined)),
    };
    const proxy = new SshClientProxy('ssh-1', reporter);
    proxy.update(client as never);

    await expect(proxy.forwardOut(4321)).resolves.toBe(channel);
    expect(client.forwardOut).toHaveBeenCalledWith(
      '127.0.0.1',
      0,
      '127.0.0.1',
      4321,
      expect.any(Function)
    );

    await expect(proxy.forwardOut(4321)).rejects.toBe(forwardError);
    expect(reporter.reportChannelError).toHaveBeenCalledWith('ssh-1', forwardError);
  });

  it('reports pty and sftp channel failures', () => {
    const ptyError = new Error('pty failed');
    const sftpError = new Error('sftp failed');
    const reporter = {
      reportChannelError: vi.fn(),
    };
    const client = {
      exec: vi.fn((_command, _options, callback) => callback(ptyError, undefined)),
      sftp: vi.fn((callback) => callback(sftpError, undefined)),
    };
    const proxy = new SshClientProxy('ssh-1', reporter);
    proxy.update(client as never);

    proxy.execPty('bash', { pty: true }, vi.fn());
    proxy.sftp(vi.fn());

    expect(reporter.reportChannelError).toHaveBeenCalledWith('ssh-1', ptyError);
    expect(reporter.reportChannelError).toHaveBeenCalledWith('ssh-1', sftpError);
  });
});

describe('SshClientProxy agent-forward refusal', () => {
  function refusingClient(refusals: number) {
    const commands: string[] = [];
    let seen = 0;
    const client = {
      config: { allowAgentFwd: true },
      exec: (command: string, optionsOrCb: unknown, maybeCb?: unknown) => {
        const callback = (typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb) as (
          err: Error | undefined,
          channel?: unknown
        ) => void;
        commands.push(command);
        if (seen++ < refusals && client.config.allowAgentFwd) {
          callback(new Error('Unable to request agent forwarding'));
          return;
        }
        callback(undefined, {
          once: (event: string, listener: () => void) => {
            // Free the proxy's exec slot the way a real channel does.
            if (event === 'close') setTimeout(listener, 0);
          },
        });
      },
    };
    return { client, commands };
  }

  it('retries exec without forwarding when the host refuses it', async () => {
    const { client, commands } = refusingClient(1);
    const proxy = new SshClientProxy('ssh-1');
    proxy.update(client as never);

    const result = await new Promise<{ err: Error | undefined; channel: unknown }>((resolve) => {
      proxy.exec('echo hi', (err, channel) => resolve({ err, channel }));
    });

    expect(result.err).toBeUndefined();
    expect(result.channel).toBeDefined();
    expect(commands).toEqual(['echo hi', 'echo hi']);
    expect(client.config.allowAgentFwd).toBe(false);
  });

  it('retries a pty channel without forwarding when the host refuses it', async () => {
    const { client, commands } = refusingClient(1);
    const proxy = new SshClientProxy('ssh-1');
    proxy.update(client as never);

    const result = await new Promise<Error | undefined>((resolve) => {
      proxy.execPty('tmux a', {}, (err) => resolve(err));
    });

    expect(result).toBeUndefined();
    expect(commands).toHaveLength(2);
    expect(client.config.allowAgentFwd).toBe(false);
  });

  it('surfaces the error when a retry is not possible', async () => {
    const { client, commands } = refusingClient(1);
    client.config.allowAgentFwd = false;
    const proxy = new SshClientProxy('ssh-1');
    proxy.update(client as never);

    const result = await new Promise<Error | undefined>((resolve) => {
      proxy.exec('echo hi', (err) => resolve(err));
    });

    // Nothing to disable, so the refusal is reported rather than looped on.
    expect(result).toBeUndefined();
    expect(commands).toEqual(['echo hi']);
  });

  it('does not leak exec slots across a forwarding retry', async () => {
    const { client, commands } = refusingClient(1);
    const proxy = new SshClientProxy('ssh-1');
    proxy.update(client as never);

    for (let i = 0; i < 8; i++) {
      await new Promise<void>((resolve) => {
        proxy.exec(`cmd-${i}`, () => resolve());
      });
    }

    // 8 commands, one of which was retried after the refusal.
    expect(commands).toHaveLength(9);
  });
});
