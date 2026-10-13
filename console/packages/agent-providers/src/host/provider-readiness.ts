import { providerRuntime } from '../providers/registry';
import { readiness, signInWith, type ProviderReadiness } from '../readiness';
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
  try {
    return await runtime.checkSignIn(input);
  } catch (error) {
    if (
      error instanceof JsonRpcError &&
      error.code === -32000 &&
      /auth|log.?in|sign.?in|API key is missing|no API key/i.test(error.message)
    )
      return readiness('unauthenticated', signInWith(runtime.loginCommand));
    return readiness(
      'unknown',
      'Could not verify authentication. Check the connection and provider setup, then retry.'
    );
  }
}
