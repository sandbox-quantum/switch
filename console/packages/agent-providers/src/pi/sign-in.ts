import { readiness, signInWith, type ProviderReadiness, type SignInCheckInput } from '../readiness';
import { noopLogger } from '../transport/stdio-json-rpc';
import type { PiModel } from './protocol';
import { PiRpcClient } from './rpc';

/**
 * Pi has no sign-in command: a person runs `pi` and signs in to a model
 * provider with `/login` inside it, or sets that provider's API key.
 */
export const PI_LOGIN = 'pi';

/**
 * What Pi reads beyond the vendor keys every provider is already given: where
 * it keeps its state, and the API keys of the model providers it lists
 * (`docs/providers.md`).
 */
export const PI_INHERIT_ENV = [
  'AI_GATEWAY_API_KEY',
  'ANTHROPIC_OAUTH_TOKEN',
  'CEREBRAS_API_KEY',
  'COPILOT_GITHUB_TOKEN',
  'DEEPSEEK_API_KEY',
  'FIREWORKS_API_KEY',
  'GROQ_API_KEY',
  'HF_TOKEN',
  'NVIDIA_API_KEY',
  'OPENCODE_API_KEY',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'TOGETHER_API_KEY',
  'ZAI_API_KEY',
] as const;

const CHECK_TIMEOUT_MS = 20_000;

export const PI_SIGNED_OUT = `${signInWith(PI_LOGIN)} Choose a provider with /login, or set a provider API key such as ANTHROPIC_API_KEY.`;

/**
 * Pi is signed in when it has a model it can use: it lists only the models of
 * providers it holds a credential for (a `/login`, an API key in the
 * environment, a local endpoint in its models file). This asks it that over
 * RPC, which starts no login and sends no model request.
 */
export async function checkPiSignIn(input: SignInCheckInput): Promise<ProviderReadiness> {
  const client = new PiRpcClient({
    command: input.binaryPath,
    // No MCP servers to connect and nothing to save: only the model list.
    args: ['--mode', 'rpc', '--no-session', '--no-mcp'],
    cwd: input.cwd,
    env: { ...input.env, PI_SKIP_VERSION_CHECK: '1' },
    logger: noopLogger,
    onEvent: () => {},
    onUiRequest: () => {},
    onExit: () => {},
  });
  try {
    const { models } = await client.request<{ models: PiModel[] }>(
      'get_available_models',
      {},
      CHECK_TIMEOUT_MS
    );
    return models.length > 0
      ? readiness('authenticated', 'Signed in.')
      : readiness('unauthenticated', PI_SIGNED_OUT);
  } finally {
    // What was read is the answer: a Pi that will not stop is reported, not put in its place.
    await client
      .dispose()
      .catch((error: unknown) =>
        console.warn(
          `The Pi that checked a sign-in did not stop: ${error instanceof Error ? error.message : String(error)}`
        )
      );
  }
}
