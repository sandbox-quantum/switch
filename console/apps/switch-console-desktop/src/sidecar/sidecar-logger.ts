import { type Level, resolveLogLevel, stringifyLogValue } from '@shared/logger';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * The sidecar's stdout is redirected to its ready file (the launcher reads the
 * `{event:"ready",…}` line from there), so logs must NOT go to stdout — the
 * shared `createLogger` routes info/debug to `console.info`/`console.debug`
 * (stdout). This logger sends EVERY level to stderr, which the launch redirects
 * to `.switchdash/*.log`, and defaults to `info` so the diagnostic logs are
 * visible without setting an env var.
 */
export function createSidecarLogger(envLevel: string | undefined, tag: string) {
  const level = resolveLogLevel({ envLevel: envLevel ?? 'info' });
  const write = (target: Level, input: unknown[]): void => {
    if (target !== 'error' && LEVEL_ORDER[target] < LEVEL_ORDER[level]) return;
    const parts = input.map((v) => (typeof v === 'string' ? v : stringifyLogValue(v)));
    process.stderr.write(`[${tag} ${target}] ${parts.join(' ')}\n`);
  };
  return {
    level,
    debug: (...input: unknown[]) => write('debug', input),
    info: (...input: unknown[]) => write('info', input),
    warn: (...input: unknown[]) => write('warn', input),
    error: (...input: unknown[]) => write('error', input),
  };
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`sidecar: missing required env ${name}`);
  }
  return value.trim();
}
