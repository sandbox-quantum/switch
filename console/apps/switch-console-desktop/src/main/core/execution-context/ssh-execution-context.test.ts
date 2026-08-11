import { EventEmitter } from 'node:events';
import { isTransportFailure } from '@switch-console/core/exec';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteShellProfile } from '@main/core/ssh/lifecycle/remote-shell-profile';
import { SshChannelTimeoutError } from '@main/core/ssh/lifecycle/ssh-channel-open-failure';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import {
  buildSshCommand,
  EXEC_STDOUT_MARKER,
  SshExecutionContext,
  stripExecBanner,
} from './ssh-execution-context';

/** Minimal channel stream double: stdout/stderr emitters + destroy. */
function makeStream() {
  const stream = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    destroy: () => void;
  };
  stream.stderr = new EventEmitter();
  stream.destroy = vi.fn();
  return stream;
}

function makeProxy(
  execImpl: (command: string, cb: (err?: Error, stream?: unknown) => void) => void
) {
  return {
    getRemoteShellProfile: () => Promise.resolve({ shell: '/bin/sh', env: {} }),
    exec: execImpl,
  } as unknown as SshClientProxy;
}

describe('buildSshCommand', () => {
  it('uses the shared remote shell command builder for fallback SSH exec commands', () => {
    const command = buildSshCommand('/workspace/location', 'which', ['claude']);

    expect(command).toBe(
      "'/bin/sh' -c 'cd '\\''/workspace/location'\\'' && which '\\''claude'\\'''"
    );
  });

  it('uses the remote shell profile and cwd when building SSH exec commands', () => {
    const profile: RemoteShellProfile = {
      shell: '/bin/zsh',
      env: {
        PATH: '/Users/jona/.local/bin:/opt/homebrew/bin:/usr/bin',
      },
    };

    const command = buildSshCommand('/workspace/location', 'which', ['claude'], profile);

    expect(command).toBe(
      "'/bin/zsh' -lc 'export PATH='\\''/Users/jona/.local/bin:/opt/homebrew/bin:/usr/bin'\\''; cd '\\''/workspace/location'\\'' && which '\\''claude'\\'''"
    );
  });

  it('disables interactive Git credential prompts for SSH exec commands', () => {
    const command = buildSshCommand('/workspace/location', 'git', ['fetch', 'origin']);

    expect(command).toBe(
      "'/bin/sh' -c 'cd '\\''/workspace/location'\\'' && GIT_ASKPASS='\\'''\\'' GIT_TERMINAL_PROMPT='\\''0'\\'' GCM_INTERACTIVE='\\''never'\\'' SSH_ASKPASS='\\'''\\'' git '\\''fetch'\\'' '\\''origin'\\'''"
    );
  });

  it('prepends the stdout marker after the cd when a marker is given', () => {
    const command = buildSshCommand(
      '/workspace/location',
      'which',
      ['claude'],
      undefined,
      EXEC_STDOUT_MARKER
    );

    // Marker printf runs only after `cd` succeeds (so a missing dir still
    // rejects) and before the command, so its output precedes real stdout.
    expect(command).toContain(EXEC_STDOUT_MARKER);
    const cdAt = command.indexOf('cd ');
    const printfAt = command.indexOf('printf');
    const whichAt = command.indexOf('which');
    expect(cdAt).toBeGreaterThanOrEqual(0);
    expect(printfAt).toBeGreaterThan(cdAt);
    expect(whichAt).toBeGreaterThan(printfAt);
  });
});

describe('SshExecutionContext.exec', () => {
  it('resolves stdout with the banner stripped on exit 0', async () => {
    const stream = makeStream();
    const ctx = new SshExecutionContext(
      makeProxy((_command, cb) => {
        cb(undefined, stream);
        queueMicrotask(() => {
          stream.emit('data', Buffer.from(`motd noise\n${EXEC_STDOUT_MARKER}\nhello\n`));
          stream.emit('close', 0);
        });
      })
    );

    await expect(ctx.exec('echo', ['hello'])).resolves.toEqual({ stdout: 'hello\n', stderr: '' });
  });

  it('honors the timeout option: destroys the stream and rejects with killed=true', async () => {
    vi.useFakeTimers();
    try {
      const stream = makeStream();
      const ctx = new SshExecutionContext(
        makeProxy((_command, cb) => {
          cb(undefined, stream); // channel opens; command never finishes
        })
      );

      const pending = ctx.exec('sleep', ['999'], { timeout: 5_000 });
      const assertion = expect(pending).rejects.toMatchObject({ killed: true });
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      expect(stream.destroy).toHaveBeenCalled();

      // A command timeout is NOT a transport failure — the pipe worked.
      await vi.advanceTimersByTimeAsync(0);
      await pending.catch((error: unknown) => {
        expect(isTransportFailure(error)).toBe(false);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('wraps a channel-open failure as a transport failure', async () => {
    const ctx = new SshExecutionContext(
      makeProxy((_command, cb) => {
        cb(Object.assign(new Error('(SSH) Channel open failure: open failed'), { reason: 2 }));
      })
    );

    const error = await ctx.exec('which', ['git']).catch((e: unknown) => e);
    expect(isTransportFailure(error)).toBe(true);
  });

  it('wraps a channel-open timeout as a transport failure', async () => {
    const ctx = new SshExecutionContext(
      makeProxy((_command, cb) => {
        cb(new SshChannelTimeoutError('SSH exec channel open timed out after 15000ms'));
      })
    );

    const error = await ctx.exec('which', ['git']).catch((e: unknown) => e);
    expect(isTransportFailure(error)).toBe(true);
  });

  it('wraps a missing connection as a transport failure', async () => {
    const proxy = {
      getRemoteShellProfile: () => Promise.reject(new Error('SSH connection is not available')),
      exec: vi.fn(),
    } as unknown as SshClientProxy;
    const ctx = new SshExecutionContext(proxy);

    const error = await ctx.exec('which', ['git']).catch((e: unknown) => e);
    expect(isTransportFailure(error)).toBe(true);
  });

  it('does not mark an ordinary non-zero exit as a transport failure', async () => {
    const stream = makeStream();
    const ctx = new SshExecutionContext(
      makeProxy((_command, cb) => {
        cb(undefined, stream);
        queueMicrotask(() => {
          stream.stderr.emit('data', Buffer.from('not found'));
          stream.emit('close', 1);
        });
      })
    );

    const error = await ctx.exec('which', ['nope']).catch((e: unknown) => e);
    expect(isTransportFailure(error)).toBe(false);
    expect(error).toMatchObject({ code: 1 });
  });
});

describe('stripExecBanner', () => {
  it('drops a login-shell banner printed before the marker', () => {
    const banner = '  _____ EXAMPLE _____\nexample-host-debian-12\n';
    const raw = `${banner}${EXEC_STDOUT_MARKER}\nreal output\n`;

    expect(stripExecBanner(raw, EXEC_STDOUT_MARKER)).toBe('real output\n');
  });

  it('yields empty output when the command printed nothing after the marker', () => {
    const raw = `motd noise\n${EXEC_STDOUT_MARKER}\n`;

    expect(stripExecBanner(raw, EXEC_STDOUT_MARKER)).toBe('');
  });

  it('returns stdout unchanged when the marker is absent', () => {
    expect(stripExecBanner('plain output', EXEC_STDOUT_MARKER)).toBe('plain output');
  });
});
