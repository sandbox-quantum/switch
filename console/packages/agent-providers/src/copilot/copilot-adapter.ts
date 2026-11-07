import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, type ParseError } from 'jsonc-parser/lib/esm/main.js';
import { z } from 'zod';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith, type ProviderReadiness } from '../readiness';

export const COPILOT_LOGIN = 'copilot login';

/** The one auth method the CLI's `initialize` reply names (verified against 1.0.105). */
const LOGIN_METHOD = 'copilot-login';

/** Tokens and inline BYOK endpoints bypass GitHub login, including keyless local providers. */
export function copilotEnvSignIn(env: Record<string, string>): boolean {
  if (env.COPILOT_GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()) {
    return true;
  }
  return Boolean(env.COPILOT_PROVIDER_BASE_URL?.trim());
}

const providersConfigSchema = z.object({
  providers: z
    .array(z.object({ name: z.string().trim().min(1), baseUrl: z.string().trim().min(1) }))
    .min(1),
  models: z
    .array(z.object({ id: z.string().trim().min(1), provider: z.string().trim().min(1) }))
    .nullish()
    .transform((models) => models ?? []),
});

/** Detect saved login or BYOK configuration without initiating authentication. */
export async function copilotSignedIn(env: Record<string, string>): Promise<boolean> {
  const home = env.COPILOT_HOME || join(env.HOME || homedir(), '.copilot');
  try {
    const path = env.COPILOT_PROVIDERS_CONFIG || join(home, 'providers.json');
    const config = providersConfigSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    if (
      config.success &&
      config.data.models.every((model) =>
        config.data.providers.some((provider) => provider.name === model.provider)
      )
    )
      return true;
  } catch {
    // A missing provider file leaves the CLI's saved GitHub login available.
  }
  try {
    const raw = await readFile(join(home, 'config.json'), 'utf8');
    const errors: ParseError[] = [];
    const config = parse(raw, errors, { allowTrailingComma: true }) as {
      loggedInUsers?: unknown;
    };
    if (errors.length || !config || typeof config !== 'object' || Array.isArray(config))
      return false;
    return Array.isArray(config.loggedInUsers) && config.loggedInUsers.length > 0;
  } catch {
    return false;
  }
}

/** Copilot uses ACP session/load for resume and the generic adapter's permission handling. */
export const copilotAcp: AcpProviderHooks = {
  provider: 'copilot',
  label: 'GitHub Copilot CLI',
  defaultBinary: 'copilot',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env, autoApprovedMcpNames = [] }) => {
    for (const name of autoApprovedMcpNames) {
      if (!/^[\w.-]+$/.test(name) || ['shell', 'write', 'read', 'memory', 'url'].includes(name))
        throw new Error(
          `Copilot cannot safely pre-approve the MCP server name ${JSON.stringify(name)}.`
        );
    }
    // ACP permission requests omit the MCP server identity. Let Copilot match its own server rules.
    return {
      command: binaryPath,
      args: ['--acp', '--stdio', ...autoApprovedMcpNames.map((name) => `--allow-tool=${name}`)],
      env,
    };
  },
  promptCapabilities: { image: true, embeddedContext: true },
  itemType: (toolCall) =>
    typeof toolCall.rawInput?.agent_type === 'string' ? 'subagent' : undefined,
  loginCommand: COPILOT_LOGIN,
  authMethodId: (env) => (copilotEnvSignIn(env) ? undefined : LOGIN_METHOD),
  // A saved `copilot login` session is already usable. Sending the ACP login
  // method in that case would unnecessarily start another browser flow.
  alreadySignedIn: async ({ env }) => copilotEnvSignIn(env) || (await copilotSignedIn(env)),
  checkSignIn: async ({ env, handshake }): Promise<ProviderReadiness> => {
    if (copilotEnvSignIn(env)) {
      return readiness(
        'authenticated',
        'Signs in with a GitHub token or provider config from the environment.'
      );
    }
    if (await copilotSignedIn(env)) {
      return readiness('authenticated', 'A saved GitHub login or custom provider is configured.');
    }
    const init = await handshake();
    return (init.authMethods ?? []).length > 0
      ? readiness('unauthenticated', signInWith(COPILOT_LOGIN))
      : readiness('unknown', 'The CLI did not advertise an authentication method.');
  },
  inheritEnv: [
    'COPILOT_HOME',
    'COPILOT_GITHUB_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'COPILOT_PROVIDERS_CONFIG',
    'COPILOT_PROVIDER_TYPE',
    'COPILOT_PROVIDER_BASE_URL',
    'COPILOT_PROVIDER_API_KEY',
    'COPILOT_PROVIDER_BEARER_TOKEN',
    'COPILOT_PROVIDER_API_KEY_COMMAND',
    'COPILOT_PROVIDER_WIRE_API',
    'COPILOT_PROVIDER_TRANSPORT',
    'COPILOT_PROVIDER_AZURE_API_VERSION',
    'COPILOT_PROVIDER_HEADERS',
    'COPILOT_MODEL',
    'COPILOT_PROVIDER_MODEL_ID',
    'COPILOT_PROVIDER_WIRE_MODEL',
    'COPILOT_PROVIDER_MAX_PROMPT_TOKENS',
    'COPILOT_PROVIDER_MAX_OUTPUT_TOKENS',
    'COPILOT_PROVIDER_VISION',
  ],
};

export function createCopilotAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(copilotAcp, options);
}
