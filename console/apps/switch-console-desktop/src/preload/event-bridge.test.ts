import { expect, it, vi } from 'vitest';
import { createEventBridge } from './event-bridge';

function fakeIpc() {
  return { send: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
}

const allowed = (channel: string) => channel === 'session:created' || channel === 'room:health.s1';

it('sends and listens on an allowed channel', () => {
  const ipc = fakeIpc();
  const bridge = createEventBridge(ipc, allowed);

  bridge.eventSend('session:created', { id: 1 });
  expect(ipc.send).toHaveBeenCalledWith('session:created', { id: 1 });

  const cb = vi.fn();
  const off = bridge.eventOn('room:health.s1', cb);
  const [channel, listener] = ipc.on.mock.calls[0]!;
  expect(channel).toBe('room:health.s1');
  listener({ sender: 'ignored' }, 'payload');
  expect(cb).toHaveBeenCalledWith('payload');

  off();
  expect(ipc.removeListener).toHaveBeenCalledWith('room:health.s1', listener);
});

it('refuses any other channel without touching ipc', () => {
  const ipc = fakeIpc();
  const bridge = createEventBridge(ipc, allowed);

  for (const channel of ['agents.list', 'session:created2', '', 'ELECTRON_BROWSER_REQUIRE']) {
    expect(() => bridge.eventSend(channel, null)).toThrow('is not an event channel');
    expect(() => bridge.eventOn(channel, () => {})).toThrow('is not an event channel');
  }
  expect(() => bridge.eventSend(42 as unknown as string, null)).toThrow('is not an event channel');
  expect(ipc.send).not.toHaveBeenCalled();
  expect(ipc.on).not.toHaveBeenCalled();
});
