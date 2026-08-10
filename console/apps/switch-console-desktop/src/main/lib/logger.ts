import { createLogger, resolveLogLevel } from '@shared/logger';
import { writeLogEntry } from './file-logger';
import { resolveLogContext } from './log-context';

/**
 * The console and the file are levelled independently.
 *
 * A single level meant the file recorded exactly what the terminal did, so a
 * shipped build — where the default is `warn` — kept only warnings and errors
 * and none of the run that led to them. The file now defaults to `info` so a
 * user's log has the story around a failure, while the console stays quiet
 * unless asked otherwise.
 */
const fileLevel = resolveLogLevel({
  envLevel: process.env.LOG_FILE_LEVEL ?? process.env.LOG_LEVEL ?? 'info',
  debugFlag: process.argv.includes('--debug-logs'),
});

export const log = createLogger({
  envLevel: process.env.LOG_LEVEL,
  debugFlag: process.argv.includes('--debug-logs'),
  sink: writeLogEntry,
  sinkLevel: fileLevel,
  // Resolution is idempotent, and the sink resolves again so that renderer and
  // sidecar entries are enriched the same way; doing it here as well is what
  // lets the console show the same identity the file records.
  contextProvider: () => resolveLogContext(undefined),
  consoleContext: true,
  onSinkError: (error) => console.error('Log sink failed:', error),
});

export type Logger = ReturnType<typeof createLogger>;
