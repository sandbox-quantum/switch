import { ConfigurationError } from './errors';

/** Stopped by SIGINT/SIGTERM, or a command that finished. */
export const EXIT_OK = 0;
/** A failure that may pass: the network, the server, or a crash. Worth restarting, with backoff. */
export const EXIT_FAILURE = 1;
/** A configuration error that a restart cannot fix. Not worth restarting until something changes. */
export const EXIT_CONFIGURATION = 2;
/** The server revoked this controller. It has to be enrolled again. */
export const EXIT_REVOKED = 3;
/** Another instance of this controller took its stream over. */
export const EXIT_TAKEN_OVER = 4;

/**
 * The exit code a command that threw `error` ends with: configuration errors,
 * the argument parser's refusals included, are permanent; everything else is
 * treated as one that may pass.
 */
export function exitCodeFor(error: unknown): typeof EXIT_FAILURE | typeof EXIT_CONFIGURATION {
  if (error instanceof ConfigurationError) return EXIT_CONFIGURATION;
  if (isParseArgsError(error)) return EXIT_CONFIGURATION;
  return EXIT_FAILURE;
}

export function isParseArgsError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS');
}
