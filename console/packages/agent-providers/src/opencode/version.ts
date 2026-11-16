import { ProviderUnavailableError } from '../adapter';
import { execProvider } from '../provider-process';

/**
 * Which OpenCode runtime drives an executable. `opencode-ai` 1.x serves the
 * HTTP API the 1.x transport speaks; `@opencode/cli` 2.x replaced that API
 * and is driven through its Agent Client Protocol server (`opencode acp`).
 */
export type OpencodeLine = 1 | 2;

/** The first major version this build cannot drive. */
export const FIRST_UNSUPPORTED_OPENCODE_MAJOR = 3;

const VERSION_TIMEOUT_MS = 15000;

export interface OpencodeVersion {
  /** Dotted version as the CLI printed it, e.g. `2.3.0`. */
  version: string;
  line: OpencodeLine;
}

/** `opencode --version` could not be run or read, so no runtime can be chosen. */
export class OpencodeVersionUnreadableError extends ProviderUnavailableError {
  constructor(binaryPath: string, detail: string, options?: { cause?: unknown }) {
    super(
      'opencode',
      `Could not tell which OpenCode ${binaryPath} is: \`opencode --version\` ${detail}`,
      options
    );
    this.name = 'OpencodeVersionUnreadableError';
  }
}

export class OpencodeUnsupportedVersionError extends ProviderUnavailableError {
  constructor(readonly version: string) {
    super(
      'opencode',
      `OpenCode ${version} is newer than this version of Switch Console supports. Update Switch Console, or install OpenCode 2: npm install -g @opencode/cli@2`
    );
    this.name = 'OpencodeUnsupportedVersionError';
  }
}

/** The version in `opencode --version` output (`1.19.5`, `opencode v2.3.0`), or null. */
export function parseOpencodeVersion(output: string): string | null {
  return output.match(/(?<![\d.])(\d+)\.(\d+)\.(\d+)/)?.[0] ?? null;
}

/** The runtime for `version`; throws for a major this build does not know. */
export function opencodeLineOf(version: string): OpencodeLine {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (major >= FIRST_UNSUPPORTED_OPENCODE_MAJOR) throw new OpencodeUnsupportedVersionError(version);
  return major >= 2 ? 2 : 1;
}

/**
 * Asks the executable which OpenCode it is. Never guesses: a version that
 * cannot be read is an error, since starting the wrong runtime would fail
 * later and less clearly.
 */
export async function readOpencodeVersion(input: {
  binaryPath: string;
  cwd: string;
  env: Record<string, string>;
}): Promise<OpencodeVersion> {
  let output: string;
  try {
    const { stdout, stderr } = await execProvider(input.binaryPath, ['--version'], {
      cwd: input.cwd,
      env: input.env,
      timeout: VERSION_TIMEOUT_MS,
    });
    output = `${stdout}\n${stderr}`;
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown; message?: unknown };
    const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim() : '';
    const how =
      typeof failure.code === 'number'
        ? `exited with code ${failure.code}`
        : typeof failure.code === 'string'
          ? `failed (${failure.code})`
          : `failed: ${String(failure.message ?? error)}`;
    throw new OpencodeVersionUnreadableError(input.binaryPath, stderr ? `${how}: ${stderr}` : how, {
      cause: error,
    });
  }
  const version = parseOpencodeVersion(output);
  if (version === null)
    throw new OpencodeVersionUnreadableError(
      input.binaryPath,
      `printed no version: ${JSON.stringify(output.trim().slice(0, 200))}`
    );
  return { version, line: opencodeLineOf(version) };
}
