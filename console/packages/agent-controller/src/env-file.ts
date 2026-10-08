import { readFile } from 'node:fs/promises';
import { ConfigurationError } from './errors';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parses an environment file the way systemd's `EnvironmentFile=` reads the
 * common cases, so one file serves both `run --env-file` and the service:
 * `NAME=value` per line, blank lines and `#` comments skipped, an optional
 * `export ` prefix, and a value in single or double quotes taken literally
 * (double quotes also unescape `\"` and `\\`). Anything else is refused with
 * its line number rather than guessed at.
 */
export function parseEnvFile(text: string, source: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line;
    const equals = body.indexOf('=');
    const name = equals === -1 ? '' : body.slice(0, equals).trim();
    if (!NAME.test(name))
      throw new ConfigurationError(
        `${source}, line ${index + 1}: expected NAME=value, where NAME is letters, digits and underscores.`
      );
    values[name] = unquote(body.slice(equals + 1).trim(), `${source}, line ${index + 1}`);
  }
  return values;
}

function unquote(value: string, where: string): string {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") {
    if (/["'\s]/.test(value))
      throw new ConfigurationError(`${where}: quote a value that holds spaces or quotes.`);
    return value;
  }
  if (value.length < 2 || value.at(-1) !== quote)
    throw new ConfigurationError(`${where}: the value's closing ${quote} is missing.`);
  const inner = value.slice(1, -1);
  return quote === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner;
}

/** Reads `path` as an environment file; see {@link parseEnvFile}. */
export async function readEnvFile(path: string): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigurationError(
      `The environment file ${path} cannot be read: ${(error as Error).message}`
    );
  }
  return parseEnvFile(text, path);
}
