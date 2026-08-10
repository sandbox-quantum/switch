import { describe, expect, it, vi } from 'vitest';
import { TmuxInjectionSink } from './tmux-injection-sink';

describe('TmuxInjectionSink', () => {
  it('acquires itself as the target while the pane is live', () => {
    const sink = new TmuxInjectionSink('agent-pane', vi.fn(), () => true);
    expect(sink.acquire()).toBe(sink);
  });

  it('returns null while the pane is not live, so the caller defers', () => {
    const sink = new TmuxInjectionSink('agent-pane', vi.fn(), () => false);
    expect(sink.acquire()).toBeNull();
  });

  it('writes payload bytes literally via send-keys -l', () => {
    const run = vi.fn();
    const sink = new TmuxInjectionSink('agent-pane', run, () => true);

    sink.write('[200~hello[201~');

    expect(run).toHaveBeenCalledWith([
      'send-keys',
      '-t',
      'agent-pane',
      '-l',
      '--',
      '[200~hello[201~',
    ]);
  });

  it('sends the submit carriage return as a literal byte', () => {
    const run = vi.fn();
    const sink = new TmuxInjectionSink('agent-pane', run, () => true);

    sink.write('\r');

    expect(run).toHaveBeenCalledWith(['send-keys', '-t', 'agent-pane', '-l', '--', '\r']);
  });
});
