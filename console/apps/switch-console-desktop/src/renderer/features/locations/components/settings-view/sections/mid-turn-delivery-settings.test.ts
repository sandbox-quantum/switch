import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  (globalThis as unknown as { window: unknown }).window = {
    electronAPI: {
      invoke: () => Promise.resolve(undefined),
      eventOn: () => () => {},
      eventSend: () => {},
    },
  };
});

import {
  MID_TURN_DELIVERY_COPY,
} from './mid-turn-delivery-settings-section';

describe('MID_TURN_DELIVERY_COPY', () => {
  it('defines steering as the default option with clear explanation', () => {
    expect(MID_TURN_DELIVERY_COPY.options.steer).toContain('Steer into running turn (default)');
    expect(MID_TURN_DELIVERY_COPY.options.queue).toContain('Always queue behind running turn');
    expect(MID_TURN_DELIVERY_COPY.info).toContain('steering');
    expect(MID_TURN_DELIVERY_COPY.info).toContain('turn starter');
  });

  it('determines delivery mode based on stored settings correctly', () => {
    const defaultMode = (settings?: { midTurnDelivery?: string }) =>
      settings?.midTurnDelivery === 'queue' ? 'queue' : 'steer';

    expect(defaultMode(undefined)).toBe('steer');
    expect(defaultMode({})).toBe('steer');
    expect(defaultMode({ midTurnDelivery: 'steer' })).toBe('steer');
    expect(defaultMode({ midTurnDelivery: 'queue' })).toBe('queue');
  });
});
