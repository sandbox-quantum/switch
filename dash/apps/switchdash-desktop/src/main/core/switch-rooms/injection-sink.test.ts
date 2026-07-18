import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';
import { PtyInjectionSink } from './injection-sink';

vi.mock('@main/core/pty/pty-session-registry', () => ({
  ptySessionRegistry: { get: vi.fn() },
}));

describe('PtyInjectionSink', () => {
  beforeEach(() => {
    vi.mocked(ptySessionRegistry.get).mockReset();
  });

  it('acquires the live PTY for its key', () => {
    const pty = { write: vi.fn() };
    vi.mocked(ptySessionRegistry.get).mockReturnValue(pty as never);

    const sink = new PtyInjectionSink('location:session:conversation');
    expect(sink.acquire()).toBe(pty);
    expect(ptySessionRegistry.get).toHaveBeenCalledWith('location:session:conversation');
  });

  it('returns null when no PTY is live', () => {
    vi.mocked(ptySessionRegistry.get).mockReturnValue(undefined as never);

    const sink = new PtyInjectionSink('location:session:conversation');
    expect(sink.acquire()).toBeNull();
  });
});
