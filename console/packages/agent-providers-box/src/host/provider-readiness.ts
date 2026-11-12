import { providerRuntime } from '../providers/registry';
import { loginCommandOf, readiness, signInWith, type ProviderReadiness } from '../readiness';
import { JsonRpcError } from '../transport/stdio-json-rpc';

export { providerReadinessSchema, type ProviderReadiness } from '../readiness';

/**
 * Whether a provider's CLI is signed in on this machine, asked of the CLI
 * itself through the provider's own check. A failure the check did not
 * recognise is reported as unknown, never as signed out.
 */
export async function checkProviderReadiness(input: {
  provider: string;
  binaryPath: string;
  cwd: string;
  env: Record<string, string>;
}): Promise<ProviderReadiness> {
  const runtime = providerRuntime(input.provider);
  const loginCommand = loginCommandOf(runtime, input.binaryPath);
  const result = await (async () => {
    try {
      return await runtime.checkSignIn(input);
    } catch (error) {
      if (
        error instanceof JsonRpcError &&
        error.code === -32000 &&
        /auth|log.?in|sign.?in|API key is missing|no API key/i.test(error.message)
      )
        return readiness('unauthenticated', signInWith(loginCommand));
      return readiness(
        'unknown',
        `Could not verify authentication. Check the connection and provider setup, then retry. (${failureDetail(error)})`
      );
    }
  })();
  return loginCommand === runtime.loginCommand ? result : { ...result, loginCommand };
}

/** What went wrong, short enough for a status line: the error and each cause, the last 1000 characters. */
function failureDetail(error: unknown): string {
  const parts: string[] = [];
  for (let next: unknown = error; next !== undefined && parts.length < 4;) {
    parts.push(next instanceof Error ? next.message : String(next));
    next = next instanceof Error ? next.cause : undefined;
  }
  const text = parts.join(': ').replace(/\s+/g, ' ').trim();
  return text.length > 1000 ? `…${text.slice(-1000)}` : text;
}
