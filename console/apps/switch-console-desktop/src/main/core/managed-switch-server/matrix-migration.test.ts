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
import { compareVersions } from '@main/lib/semver';
import { LAST_MATRIX_VERSION } from '@shared/app-identity';
import { crossesMatrixBoundary } from './matrix-migration';

/**
 * Releases whose image cannot run `python -m switch_core.cli.backfill`, because
 * they predate the command moving into the package. Before that it lived in
 * `scripts/`, which the image does not contain, so no earlier release can run
 * it either — which is why the check below is a floor rather than a list.
 */
const FIRST_BACKFILL_CAPABLE_VERSION = '0.24.0';

const AFTER = '0.99.0';
const BEFORE = '0.22.1';

describe('LAST_MATRIX_VERSION', () => {
  it('names a release whose image can actually run the backfill', () => {
    // Not pedantry: the crossing is mandatory and a failed copy blocks the
    // upgrade, so a boundary pointing at an image without the command hard-
    // blocks every install with a ModuleNotFoundError nobody sees. It was set
    // to 0.23.0 — published, in production, and predating the command — and
    // nothing else here could have caught that, because it is a fact about a
    // built artifact rather than about this code.
    expect(compareVersions(LAST_MATRIX_VERSION, FIRST_BACKFILL_CAPABLE_VERSION)).not.toBe(-1);
  });
});

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
