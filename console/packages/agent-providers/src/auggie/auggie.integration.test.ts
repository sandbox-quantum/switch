import { describe, expect, it } from 'vitest';
import { auggieAcp } from './auggie-acp';

describe('auggie integration', () => {
  it('defines capabilities matching provider expectations', () => {
    expect(auggieAcp.provider).toBe('auggie');
    expect(auggieAcp.label).toBe('Auggie CLI');
    expect(auggieAcp.defaultBinary).toBe('auggie');
    expect(auggieAcp.capabilities.approvals).toBe(true);
    expect(auggieAcp.capabilities.resume).toBe(true);
  });
});
