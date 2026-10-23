import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { expect } from 'vitest';

/**
 * The server's own log, read back so a scenario fails when the server logged an
 * error while it ran, even if every assertion passed. A bug that logs and
 * carries on (an event loop catching one bad event) would otherwise pass every
 * scenario it breaks.
 *
 * Only a log the harness can read: the throwaway stack's `switch-core.log`,
 * written with `LOG_FORMAT=json`, one record per line. A deployed
 * environment's log lives in its log backend, so there the check is off and
 * says so.
 *
 * The log is read by position, not by time: a cursor starts at the end of the
 * log when the lane starts, and each read takes the complete lines written
 * since the one before. Work a scenario sets off runs on background tasks
 * (a consumer delivering its message, a bridge relaying it) that carry no
 * request id and may log after the scenario has returned, so nothing is
 * skipped: what is logged between scenarios, during setup, or after the last
 * one is gathered as "outside the scenarios" and checked at the end of the
 * lane. Each request the harness sends carries `X-Request-Id: <scope tag>-<n>`,
 * which is how an error says which scenario it came from, wherever it lands.
 */

export interface ServerLogError {
  timestamp: string;
  logger: string;
  message: string;
  /** The request it was logged while serving, or null for background work. */
  requestId: string | null;
}

/**
 * How long the end-of-lane sweep waits for background work the last scenario
 * set off to log about it.
 */
export const SETTLE_MS = 1_500;

/**
 * Output that bypassed logging and means something failed: an uncaught
 * exception's traceback, one a thread reported on its way out, the
 * interpreter dying, or asyncio collecting a task still pending. Any other
 * line that is not a JSON record (a dependency's DeprecationWarning, a stray
 * print, uv's own messages) is not an error.
 */
const UNLOGGED_FAILURE =
  /^(Traceback \(most recent call last\):|Exception in thread |Fatal Python error:|Task was destroyed but it is pending!)/;

/** A position in the server log, always at the start of a line. */
export class ServerLogCursor {
  readonly path: string;
  private offset: number;

  private constructor(path: string, offset: number) {
    this.path = path;
    this.offset = offset;
  }

  /**
   * A cursor at the end of the log's last complete line. The server has booted
   * by now, so a log with no JSON record in it was not written with
   * `LOG_FORMAT=json` and would read as error-free whatever happened: refused.
   */
  static atEnd(path: string): ServerLogCursor {
    const raw = readLog(path, 0);
    const complete = raw.subarray(0, raw.lastIndexOf(0x0a) + 1).toString('utf8');
    if (!complete.split('\n').some((line) => parseRecord(line) !== null)) {
      throw new Error(
        `The server log at ${path} holds no JSON records: start the server ` +
          `with LOG_FORMAT=json for the harness to read it.`
      );
    }
    return new ServerLogCursor(path, Buffer.byteLength(complete, 'utf8'));
  }

  /**
   * The errors in every complete line written since the last read, moving past
   * them. A last line with no newline yet is one the server is still writing,
   * and is left for the next read.
   */
  take(): ServerLogError[] {
    const raw = readLog(this.path, this.offset);
    const end = raw.lastIndexOf(0x0a) + 1;
    this.offset += end;
    const errors: ServerLogError[] = [];
    let lastTimestamp = '(no record yet)';
    for (const line of raw.subarray(0, end).toString('utf8').split('\n')) {
      if (line.trim() === '') continue;
      const record = parseRecord(line);
      if (record === null) {
        if (UNLOGGED_FAILURE.test(line)) {
          errors.push({
            timestamp: `after ${lastTimestamp}`,
            logger: '(unstructured output)',
            message: line.slice(0, 300),
            requestId: null,
          });
        }
        continue;
      }
      lastTimestamp = record.timestamp;
      if (record.status === 'error' || record.status === 'critical') {
        errors.push({
          timestamp: record.timestamp,
          logger: record.logger,
          message: record.message.slice(0, 500),
          requestId: record.requestId,
        });
      }
    }
    return errors;
  }
}

function readLog(path: string, offset: number): Buffer {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    throw new Error(
      `Cannot read the server log at ${path} (SWITCH_E2E_SERVER_LOG): ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
  try {
    const size = fstatSync(fd).size;
    if (size < offset) {
      throw new Error(
        `The server log at ${path} shrank below what was already read (${size} < ${offset} bytes): ` +
          `was it rotated or truncated during the run?`
      );
    }
    const buffer = Buffer.alloc(size - offset);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, offset + read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

interface LogRecord {
  timestamp: string;
  status: string;
  logger: string;
  message: string;
  requestId: string | null;
}

function parseRecord(line: string): LogRecord | null {
  if (!line.startsWith('{')) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const fields = value as { [key: string]: unknown };
  if (typeof fields.timestamp !== 'string') return null;
  const logger = fields.logger as { name?: unknown } | undefined;
  return {
    timestamp: fields.timestamp,
    status: typeof fields.status === 'string' ? fields.status : '',
    logger: typeof logger?.name === 'string' ? logger.name : '?',
    message: typeof fields.message === 'string' ? fields.message : '',
    requestId: typeof fields.request_id === 'string' ? fields.request_id : null,
  };
}

/** One line per error, saying whose request it came from. */
export function describeErrors(errors: readonly ServerLogError[], tag: string | null): string {
  return errors
    .map((error) => {
      const source =
        error.requestId === null
          ? 'background work'
          : tag !== null && error.requestId.startsWith(`${tag}-`)
            ? `this scenario's request ${error.requestId}`
            : `request ${error.requestId}`;
      return `${error.timestamp} [${error.logger}] ${error.message} (${source})`;
    })
    .join('\n  ');
}

interface Taggable {
  tagRequests(tag: string | null): void;
}

/**
 * One lane's watch over the server log: per scenario, and for everything
 * logged outside them. Off (every read is null) when there is no log to read
 * here.
 */
export class ServerLogWatch {
  private readonly cursor: ServerLogCursor | null;
  private readonly outside: ServerLogError[] = [];

  constructor(serverLog: string | null) {
    this.cursor = serverLog === null ? null : ServerLogCursor.atEnd(serverLog);
  }

  /**
   * Start watching a scenario: what was logged since the last read is set
   * aside as outside any scenario, and the client tags its requests with
   * `tag` until the observer stops.
   *
   * Which scenario a tag belongs to is printed, whether or not this process
   * reads the server's log: a deployment whose log is read elsewhere (after
   * the run, from its log system) names a scenario by this line.
   */
  begin(client: Taggable, tag: string, scenario: string): ScenarioObserver {
    console.log(`[${scenario}] requests tagged ${tag}-<n>`);
    if (this.cursor !== null) this.outside.push(...this.cursor.take());
    client.tagRequests(tag);
    return new ScenarioObserver(this.cursor, client, tag);
  }

  /**
   * Everything logged outside the scenarios: during setup, between them, and
   * after the last, once its background work has had `SETTLE_MS` to log.
   * Null when the check is off.
   */
  async sweep(): Promise<ServerLogError[] | null> {
    if (this.cursor === null) return null;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    this.outside.push(...this.cursor.take());
    return this.outside.splice(0);
  }
}

export class ScenarioObserver {
  readonly tag: string;
  private readonly cursor: ServerLogCursor | null;
  private readonly client: Taggable;

  constructor(cursor: ServerLogCursor | null, client: Taggable, tag: string) {
    this.cursor = cursor;
    this.client = client;
    this.tag = tag;
  }

  /** Stop tagging the client's requests. Call it in a `finally`. */
  stop(): void {
    this.client.tagRequests(null);
  }

  /**
   * What the server logged at error level since the scenario began, or null
   * when the check is off.
   *
   * The scenario's own failure is the root cause, so a log that cannot be read
   * never replaces it: with `failure` set, that read error is only logged.
   */
  errors(failure: unknown, log: (message: string) => void): ServerLogError[] | null {
    if (this.cursor === null) return null;
    let errors: ServerLogError[];
    try {
      errors = this.cursor.take();
    } catch (error) {
      if (failure === null) throw error;
      log(
        `could not read the server log: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
    if (errors.length > 0) log(`the server logged errors:\n  ${describeErrors(errors, this.tag)}`);
    return errors;
  }
}

/** Fail when the server logged errors; `null` (the check is off) passes. */
export function expectNoServerErrors(
  errors: ServerLogError[] | null,
  tag: string | null,
  when: string
): void {
  if (errors === null) return;
  expect(errors, `the server logged errors ${when}:\n  ${describeErrors(errors, tag)}\n`).toEqual(
    []
  );
}

/** What the run's log says about the no-error check, for the run header. */
export function describeServerLogCheck(serverLog: string | null): string {
  return serverLog === null
    ? 'server-log check off: SWITCH_E2E_SERVER_LOG is not set, so errors the server logs go unseen'
    : `server-log check on: ${serverLog}`;
}
