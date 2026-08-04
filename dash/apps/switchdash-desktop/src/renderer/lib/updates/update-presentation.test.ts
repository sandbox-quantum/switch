import { describe, expect, it } from 'vitest';
import type { UpdateState } from '@renderer/lib/stores/update-store';
import { formatMegabytes, formatTransferRate, presentUpdate } from './update-presentation';

const CURRENT = '0.17.1';

function present(state: UpdateState) {
  return presentUpdate(state, CURRENT);
}

describe('presentUpdate', () => {
  it('shows the plain current version when there is nothing to do', () => {
    const idle = present({ status: 'idle' });

    expect(idle.tone).toBe('neutral');
    expect(idle.indicatorLabel).toBe('v0.17.1');
    expect(idle.indicatorIcon).toBe('none');
    expect(idle.actionable).toBe(false);
    expect(idle.progressPercent).toBeNull();
  });

  it('treats not-available the same as idle', () => {
    expect(present({ status: 'not-available' })).toEqual(present({ status: 'idle' }));
  });

  it('advertises the target version rather than a bare "Update"', () => {
    const available = present({ status: 'available', info: { version: '0.18.0' } });

    expect(available.indicatorLabel).toBe('v0.18.0');
    expect(available.detail).toBe('v0.17.1 → v0.18.0');
    expect(available.actionKind).toBe('download');
    expect(available.actionable).toBe(true);
  });

  it('still offers a download when the version is unknown', () => {
    const available = present({ status: 'available' });

    expect(available.indicatorLabel).toBe('Update');
    expect(available.actionKind).toBe('download');
  });

  describe('the three mid-flight states read differently', () => {
    const downloading = present({
      status: 'downloading',
      progress: {
        percent: 42.4,
        transferred: 13_000_000,
        total: 71_000_000,
        bytesPerSecond: 3_200_000,
      },
    });
    const downloaded = present({ status: 'downloaded' });
    const available = present({ status: 'available', info: { version: '0.18.0' } });

    it('gives each a distinct indicator label', () => {
      const labels = [
        available.indicatorLabel,
        downloading.indicatorLabel,
        downloaded.indicatorLabel,
      ];
      expect(new Set(labels).size).toBe(3);
    });

    it('reports real progress numbers while downloading', () => {
      expect(downloading.indicatorLabel).toBe('42%');
      expect(downloading.progressPercent).toBeCloseTo(42.4);
      expect(downloading.detail).toBe('12.4 MB of 67.7 MB · 3.1 MB/s');
      expect(downloading.busy).toBe(true);
    });

    it('offers a restart once downloaded, and mentions the install-on-quit fallback', () => {
      expect(downloaded.actionKind).toBe('restart');
      expect(downloaded.tone).toBe('success');
      expect(downloaded.busy).toBe(false);
      expect(downloaded.detail).toMatch(/next time you quit/i);
    });
  });

  it('degrades to a percentage when byte counts are missing', () => {
    const downloading = present({ status: 'downloading', progress: { percent: 7 } });

    expect(downloading.detail).toBe('7% downloaded');
    expect(downloading.detail).not.toMatch(/NaN/);
  });

  it('handles a download that reports no progress at all', () => {
    const downloading = present({ status: 'downloading' });

    expect(downloading.indicatorLabel).toBe('0%');
    expect(downloading.detail).toBe('0% downloaded');
  });

  it('locks out actions while installing', () => {
    const installing = present({ status: 'installing' });

    expect(installing.actionKind).toBe('none');
    expect(installing.actionLabel).toBeNull();
    expect(installing.busy).toBe(true);
    expect(installing.actionable).toBe(false);
  });

  describe('failures', () => {
    it('surfaces the real error message instead of a generic line', () => {
      const failed = present({
        status: 'error',
        message: 'Update request failed with HTTP 503',
      });

      expect(failed.detail).toBe('Update request failed with HTTP 503');
      expect(failed.tone).toBe('warning');
      expect(failed.actionKind).toBe('retry');
    });

    it('falls back to a generic line only when no message was given', () => {
      const failed = present({ status: 'error', message: '' });

      expect(failed.detail).toBe('The update could not be completed.');
    });

    it('makes failures visible in the indicator', () => {
      const failed = present({ status: 'error', message: 'boom' });

      expect(failed.indicatorIcon).toBe('alert');
      expect(failed.indicatorLabel).toBe('Update failed');
      expect(failed.actionable).toBe(true);
    });

    it('treats missing credentials as a fixable prompt, not a failure', () => {
      const auth = present({ status: 'auth-required' });

      expect(auth.title).toMatch(/sign in/i);
      expect(auth.detail).toMatch(/gh auth login/);
      expect(auth.actionKind).toBe('check');
    });
  });

  it('never renders an empty indicator label once a version is known', () => {
    const states: UpdateState[] = [
      { status: 'idle' },
      { status: 'checking' },
      { status: 'available', info: { version: '0.18.0' } },
      { status: 'not-available' },
      { status: 'downloading', progress: { percent: 1 } },
      { status: 'downloaded' },
      { status: 'installing' },
      { status: 'error', message: 'x' },
      { status: 'auth-required' },
    ];

    for (const state of states) {
      expect(present(state).indicatorLabel, state.status).not.toBe('');
    }
  });
});

describe('byte formatting', () => {
  it('formats megabytes to one decimal', () => {
    expect(formatMegabytes(0)).toBe('0.0 MB');
    expect(formatMegabytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatMegabytes(71_000_000)).toBe('67.7 MB');
  });

  it('omits a rate when the updater reports zero', () => {
    expect(formatTransferRate(0)).toBe('');
    expect(formatTransferRate(-1)).toBe('');
    expect(formatTransferRate(3_200_000)).toBe('3.1 MB/s');
  });
});
