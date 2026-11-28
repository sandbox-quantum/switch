import { expect, it, vi } from 'vitest';
import { createEventEmitter, defineEvent } from './events';

it('keeps refusing a channel the adapter refused, rather than going quiet', () => {
  const on = vi.fn(() => {
    throw new Error('refused');
  });
  const emitter = createEventEmitter({ emit: () => {}, on });
  const event = defineEvent<void>('test:refused');

  expect(() => emitter.on(event, () => {})).toThrow('refused');
  expect(() => emitter.on(event, () => {})).toThrow('refused');
  expect(on).toHaveBeenCalledTimes(2);
});
