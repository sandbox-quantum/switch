import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two ways the remote host runs a command over SSH — streaming its output,
 * and handing it a secret on stdin — share one implementation of the exec,
 * exit status and timeout handling, so a fix to one reaches the other.
 */

vi.mock('@main/core/execution-context/ssh-execution-context', () => ({
  buildSshCommand: (dir: string, command: string, args: string[]) =>
    `cd ${dir} && ${command} ${args.join(' ')}`,
  SshExecutionContext: class {},
}));
vi.mock('@main/core/fs/impl/ssh-fs', () => ({ SshFileSystem: class {} }));
vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({ ensureSshConnected: vi.fn() }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('../paths', () => ({ remoteServerStateDir: (slug: string) => `/state/${slug}` }));
vi.mock('./remote-free-port', () => ({ pickRemoteFreePorts: vi.fn() }));
vi.mock('@main/core/locations/location-transport', () => ({
  sshConnectionIdForHost: (host: string) => `ssh:${host}`,
}));

const { RemoteServerHost } = await import('./remote-host');

/** An SSH channel: stdout and stderr, a stdin that records what is written. */
class FakeStream extends EventEmitter {
  readonly stderr = new EventEmitter();
  written: string | null = null;
  destroyed = false;
  end(input: string) {
    this.written = input;
  }
  destroy() {
    this.destroyed = true;
  }
}

let stream: FakeStream;
const commands: string[] = [];

function host() {
  const proxy = {
    getRemoteShellProfile: async () => ({}),
    exec: (command: string, cb: (error: Error | null, stream: FakeStream) => void) => {
      commands.push(command);
      cb(null, stream);
    },
  };
  return new RemoteServerHost({
    sshHost: 'vm-1',
    proxy: proxy as never,
    ctx: {} as never,
    workingDir: '/home/bob/stack',
  });
}

/** Let the profile lookup resolve and the exec callback run. */
const started = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  stream = new FakeStream();
  commands.length = 0;
});

describe('streamCommand', () => {
  it('hands on every line of stdout and stderr, and resolves on a clean exit', async () => {
    const lines: string[] = [];
    const done = host().streamCommand('docker', ['compose', 'up'], (line) => lines.push(line));
    await started();

    stream.emit('data', Buffer.from('pulling\r\n\nstarting\n'));
    stream.stderr.emit('data', Buffer.from('warning: slow\n'));
    stream.emit('close', 0);

    await expect(done).resolves.toBeUndefined();
    expect(lines).toEqual(['pulling', 'starting', 'warning: slow']);
    expect(commands).toEqual(['cd /home/bob/stack && docker compose up']);
    // Nothing is written to a streamed command's stdin.
    expect(stream.written).toBeNull();
  });

  it('rejects with the tail of stderr on a failing exit', async () => {
    const done = host().streamCommand('docker', ['compose', 'up'], () => {});
    await started();

    stream.stderr.emit('data', Buffer.from('port is already allocated\n'));
    stream.emit('close', 1);

    await expect(done).rejects.toThrow('docker failed (exit 1): port is already allocated');
  });
});

describe('writeCommandInput', () => {
  it('writes the input to stdin, and discards the output', async () => {
    const done = host().writeCommandInput('docker', ['run', '-i'], 'SECRET=1\n', {
      timeoutMs: 1000,
    });
    await started();

    stream.emit('data', Buffer.from('motd from the login shell\n'));
    stream.emit('close', 0);

    await expect(done).resolves.toBeUndefined();
    expect(stream.written).toBe('SECRET=1\n');
    // The secret is on stdin, never in the command line.
    expect(commands[0]).not.toContain('SECRET');
  });

  it('gives up, and closes the channel, when the command outlives its timeout', async () => {
    vi.useFakeTimers();
    try {
      const done = host().writeCommandInput('docker', ['run', '-i'], 'x', { timeoutMs: 50 });
      const refused = expect(done).rejects.toThrow('docker timed out after 50ms');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60);

      await refused;
      expect(stream.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
