import { describe, expect, it } from 'vitest';
import { clineAcp } from './cline-acp';

describe('cline integration', () => {
  it('defines capabilities matching provider expectations', () => {
    expect(clineAcp.provider).toBe('cline');
    expect(clineAcp.label).toBe('Cline CLI');
    expect(clineAcp.defaultBinary).toBe('cline');
    expect(clineAcp.capabilities.approvals).toBe(true);
    expect(clineAcp.capabilities.resume).toBe(true);
  });
});
