import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';
import { PtyInjectionSink } from './injection-sink';

vi.mock('@main/core/pty/pty-session-registry', () => ({
  ptySessionRegistry: { get: vi.fn(), isOpenForInjection: vi.fn() },
}));

describe('PtyInjectionSink', () => {
  beforeEach(() => {
    vi.mocked(ptySessionRegistry.get).mockReset();
    // Open unless a test says otherwise — the gate is the subject of its own
    // block below, not of the lookup ones.
    vi.mocked(ptySessionRegistry.isOpenForInjection).mockReset().mockReturnValue(true);
  });

  it('acquires the live PTY for its key', () => {
    const pty = { write: vi.fn() };
    vi.mocked(ptySessionRegistry.get).mockReturnValue(pty as never);

    const sink = new PtyInjectionSink('location-1:session-1');
    expect(sink.acquire()).toBe(pty);
    expect(ptySessionRegistry.get).toHaveBeenCalledWith('location-1:session-1');
  });

  it('returns null when no PTY is live', () => {
    vi.mocked(ptySessionRegistry.get).mockReturnValue(undefined as never);

    const sink = new PtyInjectionSink('location-1:session-1');
    expect(sink.acquire()).toBeNull();
  });

  /**
   * A live pty is not the same as one ready to be typed into (CHOO-2173).
   *
   * A session auto-started to answer a room message has that message in hand
   * before its terminal exists, and for a second or two afterwards the terminal
   * is booting and then receiving the session's own opening prompt. Typing into
   * either moment loses the message — swallowed by a TUI that is not listening,
   * or tacked onto the end of the opening prompt and sent as one.
   */
  describe('the readiness gate', () => {
    it('holds the message back while the session is still starting', () => {
      const pty = { write: vi.fn() };
      vi.mocked(ptySessionRegistry.get).mockReturnValue(pty as never);
      vi.mocked(ptySessionRegistry.isOpenForInjection).mockReturnValue(false);

      const sink = new PtyInjectionSink('location-1:session-1');
      expect(sink.acquire()).toBeNull();
    });

    it('asks about its own session, not some other pane', () => {
      vi.mocked(ptySessionRegistry.get).mockReturnValue({ write: vi.fn() } as never);

      new PtyInjectionSink('location-1:session-1').acquire();

      expect(ptySessionRegistry.isOpenForInjection).toHaveBeenCalledWith('location-1:session-1');
    });

    it('lets the message through once the session is open', () => {
      const pty = { write: vi.fn() };
      vi.mocked(ptySessionRegistry.get).mockReturnValue(pty as never);
      vi.mocked(ptySessionRegistry.isOpenForInjection).mockReturnValue(true);

      const sink = new PtyInjectionSink('location-1:session-1');
      expect(sink.acquire()).toBe(pty);
    });
  });
});
