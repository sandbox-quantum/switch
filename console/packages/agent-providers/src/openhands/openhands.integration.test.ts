import { describe, expect, it } from 'vitest';
import { openhandsAcp } from './openhands-acp';

describe('openhands integration', () => {
  it('defines capabilities matching provider expectations', () => {
    expect(openhandsAcp.provider).toBe('openhands');
    expect(openhandsAcp.label).toBe('OpenHands CLI');
    expect(openhandsAcp.defaultBinary).toBe('openhands');
    expect(openhandsAcp.capabilities.approvals).toBe(true);
    expect(openhandsAcp.capabilities.resume).toBe(true);
  });
});
