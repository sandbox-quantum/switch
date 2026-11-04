import { describe, expect, it } from 'vitest';
import { DEFAULT_MID_TURN_MESSAGES, sessionInputFor } from './adapter';

describe('sessionInputFor', () => {
  it('steers only where the agent is set to and its provider can', () => {
    expect(sessionInputFor({ steering: true }, 'steer')).toBe('steer');
    expect(sessionInputFor({ steering: true }, 'queue')).toBe('queue');
    expect(sessionInputFor({ steering: false }, 'steer')).toBe('queue');
    expect(sessionInputFor({ steering: false }, 'queue')).toBe('queue');
  });

  it('steers by default', () => {
    expect(DEFAULT_MID_TURN_MESSAGES).toBe('steer');
  });
});
