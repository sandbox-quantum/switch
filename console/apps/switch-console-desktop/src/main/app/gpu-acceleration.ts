import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, type BrowserWindow } from 'electron';
import { flushLogWrites } from '@main/lib/file-logger';
import { log } from '@main/lib/logger';
import {
  fallbackPreference,
  GpuFallbackDetector,
  type GpuPreference,
  type GpuSignal,
  hardwareAccelerationForRun,
  parseGpuPreference,
  READY_TO_SHOW_TIMEOUT_MS,
} from './gpu-fallback';

function gpuLog() {
  return log.child({ component: 'gpu' });
}

/** Under user-data rather than in the settings table: it is read before the app is ready. */
function preferencePath(): string {
  return join(app.getPath('userData'), 'gpu-acceleration.json');
}

export function readGpuPreference(): GpuPreference {
  let raw: string | null;
  try {
    raw = readFileSync(preferencePath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      gpuLog().warn('Could not read the hardware acceleration setting; using the default', {
        event: 'gpu_preference_read_failed',
        error,
      });
    }
    raw = null;
  }
  return parseGpuPreference(raw);
}

export function writeGpuPreference(preference: GpuPreference): void {
  const file = preferencePath();
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(preference, null, 2)}\n`);
  renameSync(temp, file);
}

let hardwareAccelerationThisRun = true;
/** The saved choice as this run read it, to tell when a change waits on a restart. */
let preferenceAtLaunch = true;

/**
 * Turns hardware acceleration off for this run when the saved choice or the
 * launch says so. Must run before the app is ready: Chromium reads it once.
 */
export function applyGpuPreference(): void {
  const preference = readGpuPreference();
  preferenceAtLaunch = preference.hardwareAcceleration;
  const disableGpuSwitch = app.commandLine.hasSwitch('disable-gpu');
  hardwareAccelerationThisRun = hardwareAccelerationForRun(preference, disableGpuSwitch);
  if (!hardwareAccelerationThisRun) app.disableHardwareAcceleration();
}

/** Says in the log how this run draws, and why when it is without the GPU. */
export function logGpuPreference(): void {
  if (hardwareAccelerationThisRun) return;
  const preference = readGpuPreference();
  if (preference.hardwareAcceleration) {
    gpuLog().info('Hardware acceleration is off for this run: started with --disable-gpu', {
      event: 'gpu_acceleration_off',
      stage: 'disable-gpu-switch',
    });
  } else if (preference.by === 'fallback') {
    gpuLog().warn(
      `Hardware acceleration is off: it was turned off automatically on ${preference.at} ` +
        `because ${preference.detail}. Turn it back on in Settings to try the GPU again.`,
      { event: 'gpu_acceleration_off', stage: 'fallback', detail: preference.detail }
    );
  } else {
    gpuLog().info('Hardware acceleration is off: turned off in Settings', {
      event: 'gpu_acceleration_off',
      stage: 'user',
    });
  }
}

export type HardwareAccelerationState = {
  /** The saved choice, which the next launch uses. */
  enabled: boolean;
  /** Whether this run draws with the GPU. */
  activeThisRun: boolean;
  /** Whether the saved choice changed since launch, so it waits on a restart. */
  restartNeeded: boolean;
  /** Set when Console turned it off by itself, with what failed. */
  disabledAutomatically: { detail: string; at: string } | null;
};

export function hardwareAccelerationState(): HardwareAccelerationState {
  const preference = readGpuPreference();
  return {
    enabled: preference.hardwareAcceleration,
    activeThisRun: hardwareAccelerationThisRun,
    restartNeeded: preference.hardwareAcceleration !== preferenceAtLaunch,
    disabledAutomatically:
      !preference.hardwareAcceleration && preference.by === 'fallback'
        ? { detail: preference.detail, at: preference.at }
        : null,
  };
}

export function setHardwareAcceleration(enabled: boolean): void {
  writeGpuPreference(
    enabled ? { hardwareAcceleration: true } : { hardwareAcceleration: false, by: 'user' }
  );
  gpuLog().info(`Hardware acceleration turned ${enabled ? 'on' : 'off'} in Settings`, {
    event: 'gpu_preference_changed',
    enabled,
  });
}

let fellBack = false;

function fallBack(detail: string): void {
  if (fellBack) return;
  fellBack = true;
  gpuLog().error(
    `GPU acceleration is unusable: ${detail}. Restarting with hardware acceleration off; ` +
      'it can be turned back on in Settings.',
    { event: 'gpu_fallback', stage: 'relaunch', detail }
  );
  let relaunchArgs: string[] | undefined;
  try {
    writeGpuPreference(fallbackPreference(detail, new Date()));
  } catch (error) {
    // Without the saved choice the next launch would fail the same way and
    // restart again, forever. Restart once with the switch instead.
    gpuLog().error(
      'Could not save the hardware acceleration fallback; restarting with --disable-gpu',
      { event: 'gpu_fallback', stage: 'save-failed', error }
    );
    relaunchArgs = [...process.argv.slice(1), '--disable-gpu'];
  }
  // The log is written in batches, and the quit below ends in app.exit(0),
  // which would drop the lines that say why Console restarted.
  void flushLogWrites().then(() => {
    // before-quit ends in app.exit(0), which honours the relaunch scheduled here.
    app.relaunch(relaunchArgs ? { args: relaunchArgs } : undefined);
    app.quit();
  });
}

let detector: GpuFallbackDetector | null = null;

function observe(signal: GpuSignal): void {
  const decision = detector?.observe(signal);
  if (decision?.fallback) fallBack(decision.detail);
}

let watchingGpuProcess = false;

function watchGpuProcess(): void {
  if (watchingGpuProcess) return;
  watchingGpuProcess = true;
  app.on('child-process-gone', (_event, details) => {
    if (details.type !== 'GPU') return;
    gpuLog().error(`GPU process gone: ${details.reason} (exit code ${details.exitCode})`, {
      event: 'gpu_process_gone',
      reason: details.reason,
      exitCode: details.exitCode,
    });
    observe({
      kind: 'child-process-gone',
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
}

/**
 * Watches for the GPU failing to draw the main window, and restarts Console
 * without hardware acceleration when it does. Call before the window loads.
 */
export function watchGpuHealth(window: BrowserWindow): void {
  detector = new GpuFallbackDetector(hardwareAccelerationThisRun);
  watchGpuProcess();

  window.webContents.on('render-process-gone', (_event, details) => {
    gpuLog().error(`Main window renderer gone: ${details.reason} (exit code ${details.exitCode})`, {
      event: 'renderer_process_gone',
      reason: details.reason,
      exitCode: details.exitCode,
    });
    observe({ kind: 'render-process-gone', reason: details.reason, exitCode: details.exitCode });
  });

  const timer = setTimeout(() => {
    if (window.isDestroyed()) return;
    gpuLog().error(`The main window did not paint within ${READY_TO_SHOW_TIMEOUT_MS / 1000}s`, {
      event: 'gpu_ready_to_show_timeout',
      hardwareAcceleration: hardwareAccelerationThisRun,
    });
    observe({ kind: 'ready-to-show-timeout', timeoutMs: READY_TO_SHOW_TIMEOUT_MS });
    // With nothing left to fall back to, show the window as it is rather than
    // leave Console running with nothing on screen.
    if (!fellBack) window.show();
  }, READY_TO_SHOW_TIMEOUT_MS);

  window.once('ready-to-show', () => {
    clearTimeout(timer);
    observe({ kind: 'ready-to-show' });
  });
  window.once('closed', () => clearTimeout(timer));
}
