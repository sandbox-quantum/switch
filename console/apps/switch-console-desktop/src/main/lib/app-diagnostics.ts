import { app } from 'electron';
import { getLogFilePath, getLogWriteFailures, registerDiagnosticSection } from './file-logger';
import { getRunId } from './log-context';
import { log } from './logger';

/**
 * Record what this run is, once, at startup.
 *
 * Without it an exported log opens mid-sentence: no version, no platform, and
 * — because the file spans restarts — no way to tell where one launch ended
 * and the next began. A crash loop and an uneventful afternoon look alike.
 * Every entry carries the same `runId`, so a single launch can be isolated.
 */
export function logAppStart(): void {
  log.child({ component: 'app', event: 'app_start' }).info('Application starting', {
    runId: getRunId(),
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    locale: app.getLocale(),
    packaged: app.isPackaged,
  });
}

/**
 * Record how the run ended.
 *
 * The absence of this line before the next `app_start` is what identifies a
 * crash — a clean quit and a hard kill are otherwise indistinguishable after
 * the fact.
 */
export function logAppExit(reason: string): void {
  log.child({ component: 'app', event: 'app_exit' }).info('Application exiting', { reason });
}

export function registerAppDiagnostics(): void {
  registerDiagnosticSection('system info', async () => {
    const failures = getLogWriteFailures();

    const lines = [
      `app version:    ${app.getVersion()}`,
      `packaged:       ${app.isPackaged}`,
      `run id:         ${getRunId()}`,
      `platform:       ${process.platform} ${process.arch}`,
      `electron:       ${process.versions.electron}`,
      `chrome:         ${process.versions.chrome}`,
      `node:           ${process.versions.node}`,
      `locale:         ${app.getLocale()}`,
      `uptime:         ${Math.round(process.uptime())}s`,
      `log file:       ${getLogFilePath() ?? '(not initialised)'}`,
    ];

    // Surfaced rather than hidden: if writes were failing, the log below this
    // header is incomplete, and whoever reads the report needs to know that
    // before concluding anything from what is missing.
    if (failures.count > 0) {
      lines.push(
        `log write failures: ${failures.count}${failures.lastError ? ` (last: ${failures.lastError})` : ''}`
      );
    }

    return lines.join('\n');
  });
}
