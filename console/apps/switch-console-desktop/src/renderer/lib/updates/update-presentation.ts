import type { UpdateState } from '@renderer/lib/stores/update-store';
import { PRODUCT_NAME } from '@shared/app-identity';

/**
 * Single source of truth for how an update status reads to the user.
 *
 * The sidebar indicator, its panel, and the Settings card all render from this
 * one mapping. They previously each derived their own copy from the raw status
 * and drifted apart — the sidebar collapsed three statuses into one label while
 * Settings distinguished them.
 */

export type UpdateTone = 'neutral' | 'info' | 'success' | 'warning';

export type UpdateIndicatorIcon = 'none' | 'available' | 'downloading' | 'restart' | 'alert';

export type UpdateActionKind = 'none' | 'download' | 'restart' | 'retry' | 'check';

export interface UpdatePresentation {
  tone: UpdateTone;
  /** Compact text for the always-visible sidebar indicator. */
  indicatorLabel: string;
  indicatorIcon: UpdateIndicatorIcon;
  /** True when the indicator represents something the user can act on. */
  actionable: boolean;
  /** Heading inside the panel and the Settings card. */
  title: string;
  /** Supporting line; null when the title says everything. */
  detail: string | null;
  actionKind: UpdateActionKind;
  actionLabel: string | null;
  /** True while work is in flight, so surfaces can show a spinner. */
  busy: boolean;
  /** 0-100 while downloading, else null. */
  progressPercent: number | null;
}

const BYTES_PER_MB = 1024 * 1024;

export function formatMegabytes(bytes: number): string {
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

export function formatTransferRate(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return '';
  return `${(bytesPerSecond / BYTES_PER_MB).toFixed(1)} MB/s`;
}

/**
 * Build the download detail line from whatever the progress event carried.
 * electron-updater does not guarantee every field, so each part is optional and
 * the line degrades to just a percentage rather than rendering "NaN MB".
 */
function describeDownload(progress: {
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}): string {
  const parts: string[] = [];

  if (typeof progress.transferred === 'number' && typeof progress.total === 'number') {
    parts.push(`${formatMegabytes(progress.transferred)} of ${formatMegabytes(progress.total)}`);
  }

  if (typeof progress.bytesPerSecond === 'number') {
    const rate = formatTransferRate(progress.bytesPerSecond);
    if (rate) parts.push(rate);
  }

  if (parts.length === 0) {
    return `${Math.round(progress.percent ?? 0)}% downloaded`;
  }

  return parts.join(' · ');
}

export function presentUpdate(state: UpdateState, currentVersion: string): UpdatePresentation {
  const current = currentVersion ? `v${currentVersion}` : 'this version';

  switch (state.status) {
    case 'checking':
      return {
        tone: 'neutral',
        indicatorLabel: currentVersion ? `v${currentVersion}` : '',
        indicatorIcon: 'none',
        actionable: false,
        title: 'Checking for updates',
        detail: null,
        actionKind: 'none',
        actionLabel: null,
        busy: true,
        progressPercent: null,
      };

    case 'available': {
      const next = state.info?.version;
      return {
        tone: 'info',
        indicatorLabel: next ? `v${next}` : 'Update',
        indicatorIcon: 'available',
        actionable: true,
        title: 'Update available',
        detail: next ? `${current} → v${next}` : 'A new version is available.',
        actionKind: 'download',
        actionLabel: 'Download update',
        busy: false,
        progressPercent: null,
      };
    }

    case 'downloading': {
      const percent = state.progress?.percent ?? 0;
      return {
        tone: 'info',
        indicatorLabel: `${Math.round(percent)}%`,
        indicatorIcon: 'downloading',
        actionable: true,
        title: 'Downloading update',
        detail: describeDownload(state.progress ?? {}),
        actionKind: 'none',
        actionLabel: null,
        busy: true,
        progressPercent: percent,
      };
    }

    case 'downloaded':
      return {
        tone: 'success',
        indicatorLabel: 'Restart to update',
        indicatorIcon: 'restart',
        actionable: true,
        title: 'Update ready to install',
        detail: `Restart to finish installing, or ${PRODUCT_NAME} will apply it next time you quit.`,
        actionKind: 'restart',
        actionLabel: 'Restart now',
        busy: false,
        progressPercent: 100,
      };

    case 'installing':
      return {
        tone: 'success',
        indicatorLabel: 'Installing',
        indicatorIcon: 'restart',
        actionable: false,
        title: 'Installing update',
        detail: `${PRODUCT_NAME} will close and restart automatically. This may take a few seconds.`,
        actionKind: 'none',
        actionLabel: null,
        busy: true,
        progressPercent: 100,
      };

    case 'error':
      return {
        tone: 'warning',
        indicatorLabel: 'Update failed',
        indicatorIcon: 'alert',
        actionable: true,
        title: 'Update failed',
        // Surface the real reason. The generic line is only a fallback for an
        // empty message — never a replacement for one we were given.
        detail: state.message || 'The update could not be completed.',
        actionKind: 'retry',
        actionLabel: 'Try again',
        busy: false,
        progressPercent: null,
      };

    default:
      return {
        tone: 'neutral',
        indicatorLabel: currentVersion ? `v${currentVersion}` : '',
        indicatorIcon: 'none',
        actionable: false,
        title: `${PRODUCT_NAME} is up to date`,
        detail: currentVersion ? `You are on ${current}.` : null,
        actionKind: 'check',
        actionLabel: 'Check for updates',
        busy: false,
        progressPercent: null,
      };
  }
}
