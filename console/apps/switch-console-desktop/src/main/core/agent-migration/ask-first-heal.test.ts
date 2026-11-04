import { describe, expect, it, vi } from 'vitest';
import { allFeatureFlagsOff } from '@shared/core/feature-flags/feature-flags';
import type { MachineHealth } from './agent-migration-service';
import { ASK_FIRST_REASON, asksFirstFrom, healAskingFirst } from './ask-first-heal';

// The automatic move to managed on a server with hosted agents v2 on: it never
// makes a machine of this computer, nor enrols it again after a revoke (B38).

describe('healAskingFirst', () => {
  it('with v2 off it is upstream repair, enrolling again allowed', async () => {
    const heal = vi.fn(async (): Promise<MachineHealth> => ({ kind: 'changed' }));
    expect(await healAskingFirst(async () => false, heal)).toEqual({ kind: 'changed' });
    expect(heal).toHaveBeenCalledWith(true);
  });

  it('with v2 off a machine never set up stays not-set-up, so the move turns it on as upstream', async () => {
    const heal = vi.fn(async (): Promise<MachineHealth> => ({ kind: 'not-set-up' }));
    expect(await healAskingFirst(async () => false, heal)).toEqual({ kind: 'not-set-up' });
  });

  it('with v2 on it repairs without enrolling again', async () => {
    const heal = vi.fn(async (): Promise<MachineHealth> => ({ kind: 'unchanged' }));
    expect(await healAskingFirst(async () => true, heal)).toEqual({ kind: 'unchanged' });
    expect(heal).toHaveBeenCalledWith(false);
  });

  it('with v2 on a machine never set up is left alone, so the move never turns it on', async () => {
    const heal = vi.fn(async (): Promise<MachineHealth> => ({ kind: 'not-set-up' }));
    expect(await healAskingFirst(async () => true, heal)).toEqual({
      kind: 'incompatible',
      reason: ASK_FIRST_REASON,
    });
  });
});

const flags = (over: { fetchedAt?: number | null; error?: string | null; hostedV2?: boolean }) => ({
  fetchedAt: over.fetchedAt ?? null,
  error: over.error ?? null,
  flags: { ...allFeatureFlagsOff(), hosted_v2: over.hostedV2 ?? false },
});

// It fails closed: only a good read that says v2 is off repairs as upstream.
describe('asksFirstFrom', () => {
  it('a good read with v2 off: upstream repair', () => {
    expect(asksFirstFrom(flags({ fetchedAt: 1 }))).toBe(false);
  });

  it('a good read with v2 on: asks first', () => {
    expect(asksFirstFrom(flags({ fetchedAt: 1, hostedV2: true }))).toBe(true);
  });

  it('a read that failed (every flag off) heals without enrolling again', async () => {
    const failed = flags({ error: 'The server did not answer in time.' });
    expect(asksFirstFrom(failed)).toBe(true);
    const heal = vi.fn(async (): Promise<MachineHealth> => ({ kind: 'unchanged' }));
    await healAskingFirst(async () => asksFirstFrom(failed), heal);
    expect(heal).toHaveBeenCalledWith(false);
    expect(heal).not.toHaveBeenCalledWith(true);
  });

  it('never read, or no such server: asks first', () => {
    expect(asksFirstFrom(flags({}))).toBe(true);
    expect(asksFirstFrom(null)).toBe(true);
  });
});
