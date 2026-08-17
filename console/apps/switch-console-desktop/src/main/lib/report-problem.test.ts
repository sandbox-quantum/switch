import { beforeEach, describe, expect, it, vi } from 'vitest';
import { userFacingProblemChannel } from '@shared/events/problemEvents';

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit } }));
vi.mock('@main/lib/logger', () => ({ log: { error: mocks.error } }));

const { problemDetail, reportProblem } = await import('./report-problem');

describe('reportProblem', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the problem to the renderer', () => {
    reportProblem({
      key: 'auto-session:spawn-failed:agent-1:room-9',
      headline: 'Nobody is answering in that room.',
      detail: 'ECONNREFUSED',
    });

    expect(mocks.emit).toHaveBeenCalledWith(userFacingProblemChannel, {
      key: 'auto-session:spawn-failed:agent-1:room-9',
      headline: 'Nobody is answering in that room.',
      detail: 'ECONNREFUSED',
    });
  });

  it('also logs it, so a closed window cannot lose the failure', () => {
    reportProblem({ key: 'k', headline: 'Something failed in the background.', detail: null });

    expect(mocks.error).toHaveBeenCalledWith(
      'User-facing problem',
      expect.objectContaining({ key: 'k', headline: 'Something failed in the background.' })
    );
  });
});

describe('problemDetail', () => {
  it('collapses captured output onto one line', () => {
    expect(problemDetail(new Error('spawn failed:\n  ECONNREFUSED\n'))).toBe(
      'spawn failed: ECONNREFUSED'
    );
  });

  it('is null when there is nothing worth showing', () => {
    expect(problemDetail(new Error('   '))).toBeNull();
    expect(problemDetail(new Error(''))).toBeNull();
  });

  it('handles a thrown non-Error', () => {
    expect(problemDetail('just a string')).toBe('just a string');
  });
});
