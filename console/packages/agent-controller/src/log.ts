export type LogFields = Record<string, unknown>;

export type Logger = {
  debug: (message: string, fields?: LogFields) => void;
  info: (message: string, fields?: LogFields) => void;
  warn: (message: string, fields?: LogFields) => void;
  error: (message: string, fields?: LogFields) => void;
};

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

/**
 * Line-oriented log on stderr: a timestamp, the level, the message and any
 * fields as JSON. Nothing that holds a credential is ever passed in.
 */
export function createLogger(input: {
  level: string | undefined;
  write: (line: string) => void;
}): Logger {
  const configured = (input.level ?? 'info').toLowerCase();
  if (!(LEVELS as readonly string[]).includes(configured))
    throw new Error(
      `Unknown log level '${input.level}'. Use one of ${LEVELS.join(', ')} (SWITCH_CONTROLLER_LOG_LEVEL).`
    );
  const threshold = LEVELS.indexOf(configured as Level);
  const emit = (level: Level, message: string, fields?: LogFields) => {
    if (LEVELS.indexOf(level) < threshold) return;
    const suffix = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
    input.write(`${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}\n`);
  };
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** An error's message, with its cause's when it has one (`fetch failed` says nothing alone). */
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : null;
  return cause && !error.message.includes(cause) ? `${error.message} (${cause})` : error.message;
}
