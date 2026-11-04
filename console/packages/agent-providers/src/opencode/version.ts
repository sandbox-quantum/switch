import { ProviderUnavailableError } from '../adapter';
import { execProvider } from '../provider-process';

/**
 * OpenCode 2.x (`@opencode/cli`) serves a different API from 1.x (`opencode-ai`):
 * it announces itself differently, answers /provider with HTML and ignores the
 * server password. Console drives only 1.x, so 2.x is refused up front rather
 * than left to time out waiting for a 1.x server.
 */
export const OPENCODE_UNSUPPORTED_MESSAGE =
  "OpenCode 2.x isn't supported yet. Install the 1.x line: npm i -g opencode-ai@1";

const VERSION_TIMEOUT_MS = 15000;

export class OpencodeUnsupportedVersionError extends ProviderUnavailableError {
  constructor(readonly version: string) {
    super('opencode', `${OPENCODE_UNSUPPORTED_MESSAGE} (found ${version})`);
    this.name = 'OpencodeUnsupportedVersionError';
  }
}

/** The version in `opencode --version` output (`1.19.5`, `opencode v2.2.5`), or null. */
export function parseOpencodeVersion(output: string): string | null {
  return output.match(/(\d+)\.(\d+)\.(\d+)/)?.[0] ?? null;
}

export function isSupportedOpencodeVersion(version: string): boolean {
  return Number.parseInt(version.split('.')[0] ?? '', 10) < 2;
}

/**
 * Throws OpencodeUnsupportedVersionError when the binary is OpenCode 2.x or newer.
 * A version that cannot be read is let through: starting the server then reports
 * what is actually wrong.
 */
export async function assertSupportedOpencode(input: {
  binaryPath: string;
  cwd: string;
  env: Record<string, string>;
}): Promise<void> {
  let output: string;
  try {
    const { stdout, stderr } = await execProvider(input.binaryPath, ['--version'], {
      cwd: input.cwd,
      env: input.env,
      timeout: VERSION_TIMEOUT_MS,
    });
    output = `${stdout}\n${stderr}`;
  } catch {
    return;
  }
  const version = parseOpencodeVersion(output);
  if (version !== null && !isSupportedOpencodeVersion(version)) {
    throw new OpencodeUnsupportedVersionError(version);
  }
}
