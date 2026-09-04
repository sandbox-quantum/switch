import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSessionRuntime } from '@main/core/agent-runtime/types';
import { ProviderInjectionSink, ProviderPromptInjector } from './provider-injection-sink';

vi.mock('@main/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { log } = await import('@main/lib/logger');

function makeRuntime(overrides: Partial<ProviderSessionRuntime> = {}): ProviderSessionRuntime {
  return {
    sendTurn: vi.fn(async () => ({ turnId: 't1' })),
    interrupt: vi.fn(async () => {}),
    respondToRequest: vi.fn(async () => {}),
    respondToUserInput: vi.fn(async () => {}),
    isTurnRunning: vi.fn(() => false),
    notice: vi.fn(),
    getTranscript: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    ...overrides,
  } as unknown as ProviderSessionRuntime;
}

describe('ProviderInjectionSink', () => {
  beforeEach(() => {
    vi.mocked(log.error).mockReset();
  });

  /**
   * The PTY sinks defer while a terminal boots and while its opening prompt
   * goes in. A provider session has neither, and `acquire` must stay
   * unconditional besides: `!interrupt` is executed through the acquired
   * target, and it is wanted precisely while a turn is running.
   */
  it('is always acquirable, running turn or not', () => {
    const idle = new ProviderInjectionSink('session-1', makeRuntime(), vi.fn());
    expect(idle.acquire()).toBe(idle);
    const busy = new ProviderInjectionSink(
      'session-1',
      makeRuntime({ isTurnRunning: () => true }),
      vi.fn()
    );
    expect(busy.acquire()).toBe(busy);
  });

  /**
   * A turn sent mid-turn is steered into the running one rather than starting
   * its own, and a room message is a new request rather than a correction of
   * what the agent is already doing. Steered, it was answered as an aside to a
   * turn that was ending and never posted to the room at all.
   */
  it('reports busy while a turn is running so the message waits for the next one', () => {
    expect(new ProviderInjectionSink('session-1', makeRuntime(), vi.fn()).isBusy()).toBe(false);
    expect(
      new ProviderInjectionSink(
        'session-1',
        makeRuntime({ isTurnRunning: () => true }),
        vi.fn()
      ).isBusy()
    ).toBe(true);
  });

  it('delivers a write as a room-sourced turn', () => {
    const runtime = makeRuntime();
    new ProviderInjectionSink('session-1', runtime, vi.fn()).write('[Switch] hello agent');
    expect(runtime.sendTurn).toHaveBeenCalledWith('[Switch] hello agent', 'room');
  });

  it('sends nothing for an empty write', () => {
    const runtime = makeRuntime();
    new ProviderInjectionSink('session-1', runtime, vi.fn()).write('');
    expect(runtime.sendTurn).not.toHaveBeenCalled();
  });

  it('says loudly when the session refuses a room message', async () => {
    const runtime = makeRuntime({
      sendTurn: vi.fn(async () => {
        throw new Error('session is stopping');
      }) as unknown as ProviderSessionRuntime['sendTurn'],
    });
    new ProviderInjectionSink('session-1', runtime, vi.fn()).write('hello');
    await vi.waitFor(() => expect(log.error).toHaveBeenCalled());
  });

  describe('control steps', () => {
    it('interrupts through the runtime rather than by typing at it', async () => {
      const runtime = makeRuntime();
      const sink = new ProviderInjectionSink('session-1', runtime, vi.fn());
      expect(await sink.control({ kind: 'interrupt' })).toBe(true);
      expect(runtime.interrupt).toHaveBeenCalled();
    });

    it('records a notice in the session rather than prompting it', async () => {
      const notice = vi.fn();
      const sink = new ProviderInjectionSink('session-1', makeRuntime(), notice);
      expect(await sink.control({ kind: 'notice', text: 'half-applied' })).toBe(true);
      expect(notice).toHaveBeenCalledWith('half-applied');
    });

    it('declines a keystroke recipe so the caller can fall back', async () => {
      const sink = new ProviderInjectionSink('session-1', makeRuntime(), vi.fn());
      expect(await sink.control({ kind: 'raw', data: '\x1b' })).toBe(false);
      expect(await sink.control({ kind: 'prompt', text: '/clear' })).toBe(false);
    });
  });
});

describe('ProviderPromptInjector', () => {
  /**
   * The empty submit sequence is load-bearing: RoomConnection skips the second
   * write when there is nothing to send, which keeps a blank turn out of the
   * transcript after every room message.
   */
  it('passes the text through with no submit keystroke', () => {
    expect(new ProviderPromptInjector().build('hello')).toEqual({
      payload: 'hello',
      submitSequence: '',
      submitDelayMs: 0,
    });
  });
});
