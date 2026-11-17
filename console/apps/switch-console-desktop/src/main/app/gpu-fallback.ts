/**
 * Whether Console draws with the GPU, and when to stop.
 *
 * Some machines (virtual machines especially, CHOO-4493) start Chromium's GPU
 * process and then never get a frame out of it: the page loads and runs, but
 * the window is never painted, so `ready-to-show` never fires and Console's
 * window never appears. `--disable-gpu` fixes it. This is the decision logic
 * for doing that by ourselves; `gpu-acceleration.ts` wires it to Electron.
 *
 * Nothing here touches Electron or the disk, so it can be tested as is.
 */

/** Why hardware acceleration was turned off, as saved. */
export type GpuOffReason =
  /** The person turned it off in Settings. */
  | { by: 'user' }
  /** Console turned it off after the GPU failed; `detail` is what failed. */
  | { by: 'fallback'; detail: string; at: string };

/** The saved choice. Read before the app is ready, so it lives in a plain file. */
export type GpuPreference =
  | { hardwareAcceleration: true }
  | ({ hardwareAcceleration: false } & GpuOffReason);

export const DEFAULT_GPU_PREFERENCE: GpuPreference = { hardwareAcceleration: true };

/** The saved file's contents as a preference; anything unreadable means the default. */
export function parseGpuPreference(raw: string | null): GpuPreference {
  if (raw === null) return DEFAULT_GPU_PREFERENCE;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_GPU_PREFERENCE;
  }
  if (typeof value !== 'object' || value === null) return DEFAULT_GPU_PREFERENCE;
  const record = value as Record<string, unknown>;
  if (record.hardwareAcceleration !== false) return DEFAULT_GPU_PREFERENCE;
  if (record.by === 'fallback') {
    return {
      hardwareAcceleration: false,
      by: 'fallback',
      detail: typeof record.detail === 'string' ? record.detail : 'unknown GPU failure',
      at: typeof record.at === 'string' ? record.at : '',
    };
  }
  return { hardwareAcceleration: false, by: 'user' };
}

/**
 * Whether this run uses hardware acceleration: the saved choice, unless the
 * launch itself passed `--disable-gpu`.
 */
export function hardwareAccelerationForRun(
  preference: GpuPreference,
  disableGpuSwitch: boolean
): boolean {
  return preference.hardwareAcceleration && !disableGpuSwitch;
}

/** How long the main window may take to paint before the GPU is presumed stuck. */
export const READY_TO_SHOW_TIMEOUT_MS = 20_000;

/**
 * GPU process crashes after the window first painted that turn acceleration
 * off. Chromium restarts the GPU process after a crash, so one is not a reason
 * to give up on it; a few in one run is.
 */
export const GPU_CRASHES_AFTER_SHOW_LIMIT = 3;

/** Exit reasons from Electron's `child-process-gone` / `render-process-gone` that are a failure. */
const FAILURE_REASONS = new Set(['crashed', 'abnormal-exit', 'launch-failed', 'integrity-failure']);

export type GpuSignal =
  | { kind: 'child-process-gone'; type: string; reason: string; exitCode: number }
  | { kind: 'render-process-gone'; reason: string; exitCode: number }
  | { kind: 'ready-to-show' }
  | { kind: 'ready-to-show-timeout'; timeoutMs: number };

/** What to do about a signal: nothing, or relaunch without the GPU for the reason given. */
export type GpuDecision = { fallback: false } | { fallback: true; detail: string };

/**
 * Watches the startup signals of one run and says when to fall back.
 *
 * Only a run that uses hardware acceleration can fall back, and only once, so
 * a run already without it can never loop. Before the window first paints, any
 * GPU process failure, a renderer that dies, or no paint within the timeout
 * means the GPU is unusable. After it paints, only repeated GPU crashes do: a
 * renderer crash then is not the GPU's doing.
 */
export class GpuFallbackDetector {
  private shown = false;
  private decided = false;
  private gpuCrashesAfterShow = 0;

  constructor(private readonly hardwareAcceleration: boolean) {}

  observe(signal: GpuSignal): GpuDecision {
    if (signal.kind === 'ready-to-show') {
      this.shown = true;
      return { fallback: false };
    }
    if (!this.hardwareAcceleration || this.decided) return { fallback: false };

    const detail = this.failure(signal);
    if (detail === null) return { fallback: false };
    this.decided = true;
    return { fallback: true, detail };
  }

  private failure(signal: Exclude<GpuSignal, { kind: 'ready-to-show' }>): string | null {
    switch (signal.kind) {
      case 'ready-to-show-timeout':
        return this.shown
          ? null
          : `the window did not paint within ${Math.round(signal.timeoutMs / 1000)}s`;
      case 'child-process-gone': {
        if (signal.type !== 'GPU' || !FAILURE_REASONS.has(signal.reason)) return null;
        const what = `GPU process ${signal.reason} (exit code ${signal.exitCode})`;
        if (!this.shown) return `${what} before the window painted`;
        this.gpuCrashesAfterShow += 1;
        return this.gpuCrashesAfterShow >= GPU_CRASHES_AFTER_SHOW_LIMIT
          ? `${what}, ${this.gpuCrashesAfterShow} times this run`
          : null;
      }
      case 'render-process-gone':
        if (this.shown || !FAILURE_REASONS.has(signal.reason)) return null;
        return `renderer ${signal.reason} (exit code ${signal.exitCode}) before the window painted`;
    }
  }
}

/** The preference saved when Console falls back. */
export function fallbackPreference(detail: string, now: Date): GpuPreference {
  return { hardwareAcceleration: false, by: 'fallback', detail, at: now.toISOString() };
}
