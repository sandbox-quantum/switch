/**
 * The boundary is a one-way door, so the test that matters is which upgrades
 * are recognised as crossing it.
 *
 * A crossing that is missed loses the install's history permanently. A
 * crossing seen where there is none costs one container that finds nothing to
 * do. The asymmetry is why equality with the boundary counts as "not yet
 * past": the last Matrix-capable release is the version the copy runs on.
 */
import { describe, expect, it } from 'vitest';
import { LAST_MATRIX_VERSION } from '@shared/app-identity';
import { crossesMatrixBoundary } from './matrix-migration';

const AFTER = '0.24.0';
const BEFORE = '0.22.1';

describe('crossesMatrixBoundary', () => {
  it('is true going from before the boundary to after it', () => {
    expect(crossesMatrixBoundary(BEFORE, AFTER)).toBe(true);
  });

  it('is true going from the boundary itself to after it', () => {
    // The boundary release still has the homeserver and the backfill, so a
    // stack sitting on it has not migrated — it is merely able to.
    expect(crossesMatrixBoundary(LAST_MATRIX_VERSION, AFTER)).toBe(true);
  });

  it('is false when both sides are already past it', () => {
    expect(crossesMatrixBoundary(AFTER, '0.25.0')).toBe(false);
  });

  it('is false when the upgrade stops at the boundary', () => {
    // Still on a version that can read the homeserver, so nothing is at risk
    // and there is no reason to spend the copy yet.
    expect(crossesMatrixBoundary(BEFORE, LAST_MATRIX_VERSION)).toBe(false);
  });

  it('is false for a version it cannot compare', () => {
    // Not a judgement that the upgrade is safe — it is that this check cannot
    // say, and guessing either way is worse than the release sequence.
    expect(crossesMatrixBoundary('dev-checkout', AFTER)).toBe(false);
    expect(crossesMatrixBoundary(BEFORE, 'dev-checkout')).toBe(false);
  });
});
