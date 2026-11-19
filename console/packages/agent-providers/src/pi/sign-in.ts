import { execProvider } from '../provider-process';
import {
  commandOutput,
  readiness,
  type ProviderReadiness,
  type SignInCheckInput,
} from '../readiness';

/** Pi has no sign-in command of its own: `/login` is a command inside its interactive mode. */
export const PI_LOGIN = 'pi';

/**
 * What Pi reads besides the keys every provider is passed (`AGENT_ENV_VARS`):
 * where it keeps its configuration, sessions and packages, and the
 * credentials and settings of the model providers it supports that no other
 * CLI here reads: those Pi 1.5.0 documents, and the AWS SDK's for the
 * container and web-identity credentials its docs name.
 */
export const PI_INHERIT_ENV = [
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_PACKAGE_DIR',
  'AI_GATEWAY_API_KEY',
  'ANT_LING_API_KEY',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'ANTHROPIC_OAUTH_TOKEN',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_SERVICE_ACCOUNT_ID',
  'ANTHROPIC_WORKSPACE_ID',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_BASE_URL',
  'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
  'AZURE_OPENAI_RESOURCE_NAME',
  'BASETEN_API_KEY',
  'CEREBRAS_API_KEY',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_GATEWAY_ID',
  'COPILOT_GITHUB_TOKEN',
  'DEEPSEEK_API_KEY',
  'FIREWORKS_API_KEY',
  'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_API_KEY',
  'GROQ_API_KEY',
  'HF_TOKEN',
  'META_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_CN_API_KEY',
  'NVIDIA_API_KEY',
  'OPENCODE_API_KEY',
  'QWEN_TOKEN_PLAN_API_KEY',
  'QWEN_TOKEN_PLAN_CN_API_KEY',
  'RADIUS_API_KEY',
  'TOGETHER_API_KEY',
  'TYPESAFE_API_KEY',
  'XIAOMI_API_KEY',
  'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
  'ZAI_API_KEY',
  'ZAI_CODING_CN_API_KEY',
] as const;

export const PI_SIGN_IN_REQUIRED =
  "Pi has no model it can use on the execution machine. Run pi there and sign in with /login, or set a model provider's API key in its environment.";

const NO_MODELS = /No models available/;

/**
 * Reads `pi --list-models`, which lists the models of every provider Pi has a
 * credential for, under a `provider  model …` header, or says there are none.
 */
export function parsePiModelList(stdout: string, stderr = ''): ProviderReadiness {
  if (NO_MODELS.test(stdout) || NO_MODELS.test(stderr))
    return readiness('unauthenticated', PI_SIGN_IN_REQUIRED);
  const lines = stdout.split('\n').map((line) => line.trim());
  const header = lines.findIndex((line) => /^provider\s+model\b/.test(line));
  const providers = [
    ...new Set(
      lines
        .slice(header + 1)
        .filter(Boolean)
        .map((line) => line.split(/\s+/)[0] ?? '')
    ),
  ];
  if (header < 0 || providers.length === 0) {
    const said = (stderr || stdout).trim().split('\n').filter(Boolean).at(-1)?.trim() ?? '';
    return readiness(
      'unknown',
      `Pi did not list the models it can use${said ? ` ("${said.slice(0, 200)}")` : ''}.`
    );
  }
  return readiness('authenticated', `Signed in to ${providers.join(', ')}.`);
}

/**
 * Whether Pi can run a model, asked without signing it in or reaching the
 * network: `--list-models` offline reads the credentials and catalogues Pi
 * already has.
 */
export async function checkPiSignIn(input: SignInCheckInput): Promise<ProviderReadiness> {
  let stdout: string;
  let stderr = '';
  try {
    ({ stdout, stderr } = await execProvider(input.binaryPath, ['--list-models'], {
      cwd: input.cwd,
      env: { ...input.env, PI_OFFLINE: '1' },
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (error) {
    stdout = commandOutput(error);
    const errorStderr = (error as { stderr?: unknown }).stderr;
    if (typeof errorStderr === 'string') stderr = errorStderr;
  }
  return parsePiModelList(stdout, stderr);
}
