export type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured fields attached to a log entry.
 *
 * Ids are the join key and names are decoration: names are mutable (a session
 * can be renamed mid-run) so they record what the entity was called at write
 * time and must never be used to correlate entries.
 */
export type LogContext = {
  component?: string;
  runId?: string;
  sessionId?: string;
  sessionTitle?: string;
  agentId?: string;
  agentName?: string;
  agentSlug?: string;
  roomId?: string;
  roomName?: string;
  event?: string;
  stage?: string;
  errorCode?: string;
  durationMs?: number;
  attempt?: number;
};

export type LogSinkEntry = {
  level: Level;
  input: unknown[];
  source?: string;
  context?: LogContext;
};

export type LogSink = (entry: LogSinkEntry) => void;

export type Logger = {
  level: Level;
  sinkLevel: Level;
  debug: (...input: unknown[]) => void;
  info: (...input: unknown[]) => void;
  warn: (...input: unknown[]) => void;
  error: (...input: unknown[]) => void;
  child: (context: LogContext) => Logger;
};

export function mergeLogContext(
  base: LogContext | undefined,
  extra: LogContext | undefined
): LogContext | undefined {
  if (!base) return extra;
  if (!extra) return base;
  return { ...base, ...extra };
}

export function serializeLogValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return value.toString();

  if (value && typeof value === 'object') {
    try {
      return JSON.parse(stringifyLogValue(value));
    } catch {
      return String(value);
    }
  }

  return value;
}

export function stringifyLogValue(value: unknown) {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, nestedValue: unknown) => {
    if (nestedValue instanceof Error) return serializeLogValue(nestedValue);
    if (typeof nestedValue === 'bigint') return nestedValue.toString();
    if (typeof nestedValue === 'function') return `[Function ${nestedValue.name || 'anonymous'}]`;
    if (typeof nestedValue === 'symbol') return nestedValue.toString();
    if (nestedValue && typeof nestedValue === 'object') {
      if (seen.has(nestedValue)) return '[Circular]';
      seen.add(nestedValue);
    }
    return nestedValue;
  });
}

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function parseLogLevel(value: string | undefined): Level | undefined {
  if (!value) return undefined;
  const candidate = value.trim().toLowerCase();
  if (candidate in ORDER) return candidate as Level;
  return undefined;
}

export function resolveLogLevel(args?: { envLevel?: string; debugFlag?: boolean }): Level {
  return parseLogLevel(args?.envLevel) ?? (args?.debugFlag ? 'debug' : undefined) ?? 'warn';
}

export type CreateLoggerArgs = {
  envLevel?: string;
  debugFlag?: boolean;
  sink?: LogSink;
  /**
   * Level for the sink, resolved independently of the console level. The
   * console stays quiet by default while the file sink records the run, so a
   * shipped build has usable history without a noisy terminal.
   */
  sinkLevel?: Level;
  /** Ambient fields resolved at write time, merged under the entry's own context. */
  contextProvider?: () => LogContext | undefined;
  /**
   * Append the resolved context to console output as well as to the sink.
   *
   * Off by default so shipped console output stays terse, but the terminal is
   * where the app is actually watched during development — context that only
   * reaches the log file is context nobody sees while working.
   */
  consoleContext?: boolean;
  onSinkError?: (error: unknown) => void;
};

const CONSOLE_CONTEXT_KEYS: Array<keyof LogContext> = [
  'component',
  'event',
  'stage',
  'agentName',
  'agentSlug',
  'agentId',
  'sessionTitle',
  'sessionId',
  'roomName',
  'roomId',
];

const SHORTENED_ID_KEYS = new Set<keyof LogContext>(['agentId', 'sessionId', 'roomId']);

/** Compact single-token rendering, e.g. `[sidecar-launcher agent=freebsd_vt session=ac3bee1e]`. */
export function formatContextForConsole(context: LogContext): string {
  const parts: string[] = [];

  for (const key of CONSOLE_CONTEXT_KEYS) {
    const value = context[key];
    if (value === undefined || value === '') continue;

    const text = String(value);
    // Ids are for correlating against the log file, where they appear in full;
    // the leading segment is enough to recognise one by eye.
    const rendered = SHORTENED_ID_KEYS.has(key) ? text.slice(0, 8) : text;

    // A name makes its id redundant at a glance, so only one of the pair shows.
    if (key === 'agentId' && context.agentName) continue;
    if (key === 'sessionId' && context.sessionTitle) continue;
    if (key === 'roomId' && context.roomName) continue;

    parts.push(key === 'component' ? rendered : `${consoleKey(key)}=${rendered}`);
  }

  return parts.length ? `[${parts.join(' ')}]` : '';
}

function consoleKey(key: keyof LogContext): string {
  if (key === 'agentName' || key === 'agentSlug') return 'agent';
  if (key === 'sessionTitle') return 'session';
  if (key === 'roomName') return 'room';
  if (key === 'sessionId') return 'session';
  if (key === 'agentId') return 'agent';
  if (key === 'roomId') return 'room';
  return key;
}

export function createLogger(args?: CreateLoggerArgs): Logger {
  const level = resolveLogLevel({
    envLevel: args?.envLevel ?? import.meta.env?.VITE_LOG_LEVEL,
    debugFlag: args?.debugFlag,
  });
  const sinkLevel = args?.sinkLevel ?? level;

  function enabled(target: Level, against: Level): boolean {
    return ORDER[target] >= ORDER[against];
  }

  function build(bound: LogContext | undefined): Logger {
    function emit(target: Level, writer: (...input: unknown[]) => void, input: unknown[]) {
      // Errors are always recorded regardless of the configured level.
      const always = target === 'error';
      const toConsole = always || enabled(target, level);
      const toSink = Boolean(args?.sink) && (always || enabled(target, sinkLevel));
      if (!toConsole && !toSink) return;

      const context = mergeLogContext(args?.contextProvider?.(), bound);

      if (toConsole) {
        const suffix = args?.consoleContext && context ? formatContextForConsole(context) : '';
        writer(...(suffix ? [...input, suffix] : input));
      }

      if (!args?.sink || !toSink) return;

      try {
        args.sink({
          level: target,
          input,
          context,
        });
      } catch (error) {
        // Sink failures must never break the caller, but they must not be
        // invisible either — a logger that silently stops recording is worse
        // than no logger at all.
        args.onSinkError?.(error);
      }
    }

    return {
      level,
      sinkLevel,
      debug: (...input: unknown[]) => emit('debug', console.debug, input),
      info: (...input: unknown[]) => emit('info', console.info, input),
      warn: (...input: unknown[]) => emit('warn', console.warn, input),
      error: (...input: unknown[]) => emit('error', console.error, input),
      child: (context: LogContext) => build(mergeLogContext(bound, context)),
    };
  }

  return build(undefined);
}
