import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import { openSsh2Pty, Ssh2PtySession } from './ssh2-pty';

class FakeClientChannel extends EventEmitter {
  writes: string[] = [];
  windows: Array<{ rows: number; cols: number; height: number; width: number }> = [];
  closed = false;
  /** When false, `write()` returns false to simulate a full send buffer. */
  acceptWrites = true;

  write(data: string): boolean {
    this.writes.push(data);
    return this.acceptWrites;
  }

  setWindow(rows: number, cols: number, height: number, width: number): void {
    this.windows.push({ rows, cols, height, width });
  }

  close(): void {
    this.closed = true;
    this.emit('close', 0, undefined);
  }
}

describe('Ssh2PtySession', () => {
  it('wraps SSH channel data, input, resize, close, and exit semantics', () => {
    const channel = new FakeClientChannel();
    const session = new Ssh2PtySession('ssh-session', channel as never);
    const dataHandler = vi.fn();
    const exitHandler = vi.fn();

    session.onData(dataHandler);
    session.onExit(exitHandler);
    session.write('hello');
    session.resize(132, 43);
    channel.emit('data', Buffer.from('remote output'));
    session.kill();

    expect(channel.writes).toEqual(['hello']);
    expect(channel.windows).toEqual([{ rows: 43, cols: 132, height: 0, width: 0 }]);
    expect(dataHandler).toHaveBeenCalledWith('remote output');
    expect(channel.closed).toBe(true);
    expect(exitHandler).toHaveBeenCalledWith({ exitCode: 0, signal: undefined });
  });

  it('defers writes while the channel buffer is full and flushes them on drain, in order', () => {
    const channel = new FakeClientChannel();
    const session = new Ssh2PtySession('s', channel as never);

    channel.acceptWrites = false; // buffer over high-water mark
    session.write('a'); // buffered by ssh2, returns false -> start draining
    session.write('b'); // deferred
    session.write('c'); // deferred
    expect(channel.writes).toEqual(['a']);

    channel.acceptWrites = true;
    channel.emit('drain');
    expect(channel.writes).toEqual(['a', 'b', 'c']);
    expect(channel.listenerCount('drain')).toBe(0);
  });

  it('keeps deferring across multiple drains while the channel stays full', () => {
    const channel = new FakeClientChannel();
    const session = new Ssh2PtySession('s', channel as never);

    channel.acceptWrites = false;
    session.write('a'); // draining
    session.write('b'); // deferred
    channel.emit('drain'); // still full: 'b' is buffered but write returns false again
    expect(channel.writes).toEqual(['a', 'b']);

    channel.acceptWrites = true;
    session.write('c'); // still deferred (draining re-armed)
    channel.emit('drain');
    expect(channel.writes).toEqual(['a', 'b', 'c']);
  });

  it('drops deferred writes and removes the drain listener on kill()', () => {
    const channel = new FakeClientChannel();
    const session = new Ssh2PtySession('s', channel as never);

    channel.acceptWrites = false;
    session.write('a'); // draining
    session.write('b'); // deferred
    session.kill();

    expect(channel.closed).toBe(true);
    expect(channel.listenerCount('drain')).toBe(0);

    channel.acceptWrites = true;
    channel.emit('drain'); // no-op, listener removed
    session.write('c'); // ignored, session closed
    expect(channel.writes).toEqual(['a']);
  });
});

describe('openSsh2Pty retry', () => {
  const spawn = { id: 'ssh-1', command: 'bash', cols: 80, rows: 24 };

  /** A proxy whose execPty fails `failures` times (pty-req error) then succeeds. */
  function makeProxy(failures: number) {
    let calls = 0;
    const execPty = vi.fn((_cmd, _opts, cb) => {
      calls += 1;
      if (calls <= failures) {
        cb(new Error('Unable to request a pseudo-terminal'), undefined);
      } else {
        cb(undefined, new FakeClientChannel() as never);
      }
    });
    return { proxy: { execPty } as unknown as SshClientProxy, execPty };
  }

  it('retries with backoff and succeeds once the channel opens', async () => {
    vi.useFakeTimers();
    try {
      const { proxy, execPty } = makeProxy(2);
      const promise = openSsh2Pty(proxy, spawn);
      // Two failures → two backoff waits (500ms + 1000ms) before the 3rd succeeds.
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await promise;
      expect(result.success).toBe(true);
      expect(execPty).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after exhausting retries and returns the failure', async () => {
    vi.useFakeTimers();
    try {
      const { proxy, execPty } = makeProxy(Number.POSITIVE_INFINITY);
      const promise = openSsh2Pty(proxy, spawn);
      // Exhaust all four backoff steps (500+1000+2000+4000ms).
      await vi.advanceTimersByTimeAsync(8_000);
      const result = await promise;
      expect(result.success).toBe(false);
      // 1 initial attempt + 4 retries.
      expect(execPty).toHaveBeenCalledTimes(5);
      if (!result.success) {
        expect(result.error.kind).toBe('channel-open-failed');
        expect(result.error.message).toContain('pseudo-terminal');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a synchronous execPty throw (connection unavailable) as retryable', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const execPty = vi.fn((_cmd, _opts, cb) => {
        calls += 1;
        if (calls === 1) throw new Error('SSH connection is not available');
        cb(undefined, new FakeClientChannel() as never);
      });
      const proxy = { execPty } as unknown as SshClientProxy;
      const promise = openSsh2Pty(proxy, spawn);
      await vi.advanceTimersByTimeAsync(500);
      const result = await promise;
      expect(result.success).toBe(true);
      expect(execPty).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
