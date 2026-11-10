import { spawnProvider, stopProvider } from '../provider-process';
import { readiness, signInWith, type ProviderReadiness, type SignInCheckInput } from '../readiness';

export const AMP_LOGIN = 'amp login';

/**
 * What Amp prints when a command finds no credentials: either it refuses
 * (`threads new`), or it starts a device-code sign-in and waits for a browser
 * (execute mode, `tools list`), which nothing Switch runs may be left at.
 */
export const AMP_LOGIN_FLOW = /No API key found|Starting login flow|Invalid or missing API key/i;

export const AMP_SIGNED_OUT = `Amp is not signed in. ${signInWith(AMP_LOGIN)} Or set AMP_API_KEY to an access token from ampcode.com/settings.`;

export interface AmpCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** Amp started its interactive sign-in instead of running the command; it was stopped. */
  signedOut: boolean;
  timedOut: boolean;
}

/**
 * Runs one short `amp` command to completion. Stopped as soon as Amp says it
 * is starting its device sign-in, so neither a check nor a session start ever
 * leaves a sign-in waiting on the machine.
 */
export function runAmp(
  binaryPath: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number }
): Promise<AmpCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawnProvider(binaryPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let signedOut = false;
    let timedOut = false;
    const stop = () => stopProvider(child, 'SIGKILL');
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const watch = (chunk: Buffer, into: 'stdout' | 'stderr') => {
      const text = chunk.toString('utf8');
      if (into === 'stdout') stdout += text;
      else stderr += text;
      if (!signedOut && AMP_LOGIN_FLOW.test(text)) {
        signedOut = true;
        stop();
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => watch(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => watch(chunk, 'stderr'));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, signedOut, timedOut });
    });
  });
}

/**
 * Whether Amp is signed in, answered without signing it in: an access token in
 * `AMP_API_KEY`, which Amp prefers to anything saved, or an account saved by
 * `amp login`, which `amp account list` reads from disk without a sign-in.
 */
export async function checkAmpSignIn(input: SignInCheckInput): Promise<ProviderReadiness> {
  if (input.env.AMP_API_KEY?.trim())
    return readiness('authenticated', 'Signed in with AMP_API_KEY.');
  let result: AmpCommandResult;
  try {
    result = await runAmp(input.binaryPath, ['account', 'list', '--no-color'], {
      cwd: input.cwd,
      env: input.env,
      timeoutMs: 15_000,
    });
  } catch {
    return readiness('unknown', 'Could not run amp to check its sign-in.');
  }
  return parseAmpAccountList(result);
}

export function parseAmpAccountList(result: AmpCommandResult): ProviderReadiness {
  if (result.signedOut || /No saved accounts/i.test(result.stdout))
    return readiness('unauthenticated', AMP_SIGNED_OUT);
  if (result.timedOut)
    return readiness('unknown', 'amp account list did not answer in 15 seconds.');
  if (result.code === 0 && result.stdout.trim()) return readiness('authenticated', 'Signed in.');
  const said = (result.stderr.trim() || result.stdout.trim()).split('\n').at(-1) ?? '';
  return readiness(
    'unknown',
    `amp account list did not say whether Amp is signed in${said ? ` ("${said.slice(0, 200)}")` : ''}. It may be too old: update it with amp update.`
  );
}
