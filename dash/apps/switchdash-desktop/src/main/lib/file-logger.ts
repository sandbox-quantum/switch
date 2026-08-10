import { appendFile, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { APP_SCHEME } from '@main/app/protocol';
import {
  serializeLogValue,
  stringifyLogValue,
  type Level,
  type LogContext,
  type LogSinkEntry,
} from '@shared/logger';
import { resolveLogContext } from './log-context';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const DIAGNOSTIC_LOG_BYTES = 500 * 1024;
const RETAINED_LOG_FILES = 5;
const LOG_FILE_NAME = 'switchdash.log';
const DIAGNOSTIC_ATTACHMENT_FILENAME = 'switchdash-diagnostics.log';
const RENDERER_LOG_PAYLOAD_LIMIT = 64 * 1024;
const PROCESS_EXIT_FLUSH_TIMEOUT_MS = 1000;
const FLUSH_INTERVAL_MS = 250;
const FLUSH_BYTES = 64 * 1024;
const DIAGNOSTIC_SECTION_TIMEOUT_MS = 5000;

/** The words that mark a value as a credential. */
const SECRET_KEY_WORDS =
  'authorization|api[_-]?key|private[_-]?key|token|password|passphrase|secret|credential';

/**
 * A credential-bearing key name, with any number of leading qualifier segments.
 *
 * The qualifier prefix is load-bearing, not decoration: a bare `\b` before
 * `token` does not match `bot_token`, because `_` is a word character and there
 * is no boundary inside it. Real config keys are almost always qualified —
 * `bot_token`, `app_token`, `admin_password`, `client_secret` — so without this
 * the alternation only caught the unqualified spelling nobody uses.
 */
const SECRET_KEY_NAMES = `(?:[a-z0-9]+[_-])*(?:${SECRET_KEY_WORDS})`;

type RedactionReplacement = string | ((substring: string, ...args: string[]) => string);

const SECRET_PATTERNS: Array<[RegExp, RedactionReplacement]> = [
  // JSON-quoted key/value: handles both "key":"value" and escaped \"key\":\"value\"
  [
    new RegExp(`(\\\\?")(${SECRET_KEY_NAMES})(\\\\?")(\\s*:\\s*)\\\\?"[^"\\\\]*\\\\?"`, 'gi'),
    (_match, openQuote: string, keyName: string, closeQuote: string, separator: string) =>
      `${openQuote}${keyName}${closeQuote}${separator}${openQuote}[REDACTED]${openQuote}`,
  ],
  // Unquoted: key=value, or key: <scheme> value. The scheme alternation must
  // stay in step with the auth schemes we might log: without `bot`, Discord's
  // `Authorization: Bot <token>` redacts the word "Bot" and leaves the token.
  [
    new RegExp(
      `\\b(${SECRET_KEY_NAMES})(\\s*[:=]\\s*)(?:(?:bearer|bot|token)\\s+)?[^\\s,"'}]+`,
      'gi'
    ),
    '$1$2[REDACTED]',
  ],
  // PEM blocks (private keys)
  [/-----BEGIN[^-\n]{1,40}-----[\s\S]+?-----END[^-\n]{1,40}-----/g, '[REDACTED_PEM_BLOCK]'],
  // Known token prefixes — order matters: vendor-specific before generic
  [/\bgh[opsu]_[A-Za-z0-9]{36,255}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_GITLAB_TOKEN]'],
  [/\bnpm_[A-Za-z0-9]{36,}\b/g, '[REDACTED_NPM_TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g, '[REDACTED_STRIPE_KEY]'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_ANTHROPIC_KEY]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_OPENAI_KEY]'],
  // `xoxe` is a rotating/refresh token; `xapp` is an app-level token, which a
  // Slack bridge needs alongside the bot token for Socket Mode.
  [/\b(?:xox[abepprs]|xapp)-[A-Za-z0-9-]{15,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  // Discord bot token: base64 client id . 6-char timestamp . hmac. Unprefixed,
  // so it is matched structurally. Kept after the JWT rule, whose middle
  // segment is far longer than six characters, so the two cannot collide.
  [/\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g, '[REDACTED_DISCORD_TOKEN]'],
];

const PII_PATTERNS: Array<[RegExp, RedactionReplacement]> = [
  // Any scheme://user:pass@ — covers postgres, mongodb, redis, mysql, amqp, https…
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/?#@]+:[^\s@/?#]+@/gi, '$1[REDACTED_CREDENTIALS]@'],
  [/\b(git|hg|svn)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '$1@[REDACTED_HOST]'],
  [/\b(?:[A-F0-9]{2}:){5}[A-F0-9]{2}\b/gi, '[REDACTED_MAC]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED_IP]'],
  [/\b(?:[A-F0-9]{1,4}:){2,7}[A-F0-9]{1,4}\b/gi, '[REDACTED_IP]'],
  [/\/Users\/[^\s/]+/gi, '/Users/[REDACTED_USER]'],
  [/\/home\/[^\s/]+/g, '/home/[REDACTED_USER]'],
  [/[A-Z]:\\Users\\[^\s\\]+/gi, (match) => `${match.slice(0, 9)}[REDACTED_USER]`],
];

let logFilePath: string | undefined;
let logDirReady = false;
let pendingWrite: Promise<void> = Promise.resolve();

let buffer: string[] = [];
let bufferedBytes = 0;
let flushTimer: NodeJS.Timeout | undefined;
let failedWrites = 0;
let lastWriteError: string | undefined;

export function initializeFileLogger() {
  const electronApp = app as Electron.App | undefined;
  if (!electronApp?.setAppLogsPath) return;

  electronApp.setAppLogsPath(join(electronApp.getPath('userData'), 'logs'));
  logFilePath = join(electronApp.getPath('logs'), LOG_FILE_NAME);
}

export function getLogFilePath() {
  return logFilePath;
}

/**
 * A sink that has stopped recording must not do so quietly: an empty log file
 * looks identical to an uneventful run, and the user only finds out when the
 * diagnostics they send back turn out to be blank.
 */
function recordWriteFailure(error: unknown) {
  failedWrites += 1;
  lastWriteError = error instanceof Error ? error.message : String(error);
  console.error('Failed to write application log:', error);
}

export function getLogWriteFailures(): { count: number; lastError?: string } {
  return { count: failedWrites, lastError: lastWriteError };
}

type DiagnosticSection = { title: string; collect: () => Promise<string> };

const diagnosticSections: DiagnosticSection[] = [];

/**
 * Contribute an extra section to the diagnostic attachment.
 *
 * Registered rather than imported for the same reason the context resolvers
 * are: the subsystems worth reporting on all log, so importing them here would
 * be a cycle.
 */
export function registerDiagnosticSection(title: string, collect: () => Promise<string>): void {
  diagnosticSections.push({ title, collect });
}

/** Test seam. */
export function clearDiagnosticSections(): void {
  diagnosticSections.length = 0;
}

async function collectDiagnosticSections(): Promise<string> {
  if (!diagnosticSections.length) return '';

  const collected = await Promise.all(
    diagnosticSections.map(async ({ title, collect }) => {
      try {
        // A section that hangs must not hold the report hostage; a remote pull
        // over SSH can stall indefinitely on an unreachable host.
        const body = await withTimeout(collect(), DIAGNOSTIC_SECTION_TIMEOUT_MS);
        if (body === TIMED_OUT) return `===== ${title} =====\n(timed out collecting)\n`;
        return body.trim() ? `===== ${title} =====\n${body.trim()}\n` : '';
      } catch (error) {
        // Say so rather than omitting the section: a silently missing section
        // reads as "there was nothing to report".
        return `===== ${title} =====\n(failed to collect: ${String(error)})\n`;
      }
    })
  );

  return collected.filter(Boolean).join('\n');
}

const TIMED_OUT = Symbol('timed-out');

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return Promise.race([
    promise,
    new Promise<typeof TIMED_OUT>((resolve) => {
      const timer = setTimeout(() => resolve(TIMED_OUT), ms);
      timer.unref?.();
    }),
  ]);
}

export async function getDiagnosticLogAttachment() {
  if (!logFilePath) initializeFileLogger();
  const path = logFilePath;

  const fallback = {
    filename: DIAGNOSTIC_ATTACHMENT_FILENAME,
    mimeType: 'text/plain' as const,
    content: 'No application logs were available.',
  };

  if (!path) return fallback;

  // Buffered entries are part of the run being reported on.
  await flushLogWrites();

  const raw = await readFile(path, 'utf8').catch(() => '');
  const tail = trimToLineBoundary(raw, DIAGNOSTIC_LOG_BYTES);
  const sections = await collectDiagnosticSections();

  const body = sections ? `${sections}\n===== application log =====\n${tail}` : tail;

  // Personal data is removed here rather than on write: this is the only path
  // by which log content leaves the machine, so scrubbing at the boundary keeps
  // the exported copy exactly as safe while leaving the user's own log
  // readable enough to debug from. Contributed sections go through the same
  // pass, so a section cannot become a way around it.
  const redacted = redactDiagnosticLog(body);

  return {
    filename: DIAGNOSTIC_ATTACHMENT_FILENAME,
    mimeType: 'text/plain' as const,
    content: redacted || fallback.content,
  };
}

export function writeLogEntry(entry: LogSinkEntry) {
  if (!logFilePath) initializeFileLogger();
  const path = logFilePath;
  if (!path) return;

  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    level: entry.level,
    source: entry.source ?? 'main',
    ...omitEmptyContext(resolveLogContext(entry.context)),
    message: formatMessage(entry.input),
    data: structuredArgs(entry.input),
  });
  const line = `${redactSecrets(payload)}\n`;

  buffer.push(line);
  bufferedBytes += Buffer.byteLength(line);

  // An error may be the last thing recorded before a crash, so it is not left
  // sitting in a buffer waiting for a timer that will never fire.
  if (entry.level === 'error' || bufferedBytes >= FLUSH_BYTES) {
    void flushBuffer();
    return;
  }

  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void flushBuffer();
  }, FLUSH_INTERVAL_MS);
  // Never let a pending log flush be the reason the process stays alive.
  flushTimer.unref?.();
}

/**
 * Append everything buffered as a single write.
 *
 * Batching keeps the file sink viable at `info`: one append and one rotation
 * check per batch rather than per entry, and the promise chain grows once per
 * flush instead of once per log call.
 */
function flushBuffer(): Promise<void> {
  if (!buffer.length) return pendingWrite;

  const path = logFilePath;
  if (!path) return pendingWrite;

  const chunk = buffer.join('');
  buffer = [];
  bufferedBytes = 0;

  pendingWrite = pendingWrite
    .then(async () => {
      if (!logDirReady) {
        await mkdir(join(path, '..'), { recursive: true });
        logDirReady = true;
      }
      await rotateIfNeeded(path, Buffer.byteLength(chunk));
      await appendFile(path, chunk, 'utf8');
    })
    .catch((error) => {
      recordWriteFailure(error);
    });

  return pendingWrite;
}

export function flushLogWrites() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  return flushBuffer();
}

export function registerProcessErrorLogging(log: {
  error: (message: string, details?: unknown) => void;
}) {
  process.on('uncaughtException', (error) => {
    log.error('Uncaught exception', serializeLogValue(error));
    flushAndExit();
  });

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', serializeLogValue(reason));
    flushAndExit();
  });
}

function flushAndExit() {
  const flush = Promise.race([
    flushLogWrites(),
    new Promise<void>((resolve) => setTimeout(resolve, PROCESS_EXIT_FLUSH_TIMEOUT_MS)),
  ]);
  void flush.finally(() => process.exit(1));
}

export function registerRendererLogHandler(ipcMain: Electron.IpcMain) {
  ipcMain.on('switchdash:renderer-log', (event, payload: unknown) => {
    if (!isTrustedRendererSender(event.senderFrame)) return;
    const parsed = parseRendererLog(payload);
    if (!parsed) return;
    writeLogEntry(capPayload(parsed));
  });
}

/**
 * Keep the head of an oversized entry instead of discarding it.
 *
 * Entries large enough to breach the limit are the ones worth having — a big
 * error object, a failed response body — so dropping them silently removed the
 * best evidence and left no sign that anything was missing.
 */
function capPayload(entry: LogSinkEntry): LogSinkEntry {
  const size = payloadSize(entry.input);
  if (size <= RENDERER_LOG_PAYLOAD_LIMIT) return entry;

  const kept: unknown[] = [];
  let used = 0;

  for (const value of entry.input) {
    const encoded = typeof value === 'string' ? value : stringifyLogValue(value);
    const remaining = RENDERER_LOG_PAYLOAD_LIMIT - used;
    if (remaining <= 0) break;

    if (encoded.length <= remaining) {
      kept.push(value);
      used += encoded.length;
      continue;
    }

    kept.push(`${encoded.slice(0, remaining)}…`);
    break;
  }

  return {
    ...entry,
    input: [...kept, { truncated: { originalBytes: size, keptBytes: used } }],
  };
}

function payloadSize(input: unknown[]): number {
  try {
    return input.reduce<number>(
      (total, value) =>
        total + (typeof value === 'string' ? value.length : stringifyLogValue(value).length),
      0
    );
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isTrustedRendererSender(frame: Electron.WebFrameMain | null): boolean {
  if (!frame) return false;
  try {
    const url = frame.url;
    if (!url) return false;
    if (url.startsWith(`${APP_SCHEME}://`)) return true;
    // Allow dev server during local development only
    if (process.env.NODE_ENV !== 'production' && url.startsWith('http://localhost:')) return true;
    return false;
  } catch {
    return false;
  }
}

async function rotateIfNeeded(path: string, incomingBytes: number) {
  const current = await stat(path).catch(() => undefined);
  if (!current || current.size + incomingBytes <= MAX_LOG_BYTES) return;

  await unlink(`${path}.${RETAINED_LOG_FILES}`).catch(() => undefined);

  for (let index = RETAINED_LOG_FILES - 1; index >= 1; index -= 1) {
    await rename(`${path}.${index}`, `${path}.${index + 1}`).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Log rotation rename failed:', error);
      }
    });
  }

  await rename(path, `${path}.1`).catch((error) => {
    console.error('Log rotation rename failed:', error);
  });
}

function trimToLineBoundary(value: string, maxBytes: number) {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maxBytes) return value;
  const sliced = encoded.slice(-maxBytes).toString('utf8');
  const newline = sliced.indexOf('\n');
  if (newline === -1 || newline === sliced.length - 1) return sliced;
  return sliced.slice(newline + 1);
}

function parseRendererLog(payload: unknown): LogSinkEntry | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  if (!isLevel(record.level)) return undefined;
  const input = Array.isArray(record.input) ? record.input : [record.input];
  return {
    level: record.level,
    source: 'renderer',
    input,
    context: isLogContext(record.context) ? record.context : undefined,
  };
}

function isLogContext(value: unknown): value is LogContext {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLevel(value: unknown): value is Level {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

/**
 * The human-readable part of the line: the string arguments only.
 *
 * Structured arguments are recorded separately by `structuredArgs`, so keeping
 * them out of here stops every entry from carrying the same payload twice —
 * which at a 5 MiB rotation directly halves how much history is retained.
 */
function formatMessage(input: unknown[]) {
  const strings = input.filter((value): value is string => typeof value === 'string');
  if (strings.length) return strings.join(' ');

  // A bare `log.error(err)` would otherwise produce an empty message; the error
  // text is worth the small overlap with `data`.
  const firstError = input.find((value) => value instanceof Error);
  return firstError instanceof Error ? firstError.message : '';
}

function structuredArgs(input: unknown[]) {
  const structured = input.filter((value) => typeof value !== 'string');
  return structured.length ? structured.map(serializeLogValue) : undefined;
}

function omitEmptyContext(context: LogContext | undefined) {
  if (!context) return undefined;
  const entries = Object.entries(context).filter(([, value]) => value !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function redactDiagnosticLog(value: string) {
  return redactPii(redactSecrets(value));
}

/**
 * Applied to every entry on the way to disk. Secrets are removed here and
 * never recorded; personal data is left intact for local debugging and removed
 * by `redactDiagnosticLog` at the point content leaves the machine.
 */
export function redactSecrets(value: string) {
  return applyRedactions(value, SECRET_PATTERNS);
}

function redactPii(value: string) {
  return applyRedactions(value, PII_PATTERNS);
}

function applyRedactions(value: string, patterns: Array<[RegExp, RedactionReplacement]>) {
  return patterns.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement as string),
    value
  );
}
