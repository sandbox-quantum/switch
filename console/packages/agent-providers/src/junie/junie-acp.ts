import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness } from '../readiness';

export const junieAcp: AcpProviderHooks = {
  provider: 'junie',
  label: 'Junie',
  defaultBinary: 'junie',
  loginCommand: 'junie',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  inheritEnv: [
    'JUNIE_API_KEY',
    'JUNIE_ANTHROPIC_API_KEY',
    'JUNIE_OPENAI_API_KEY',
    'JUNIE_GOOGLE_API_KEY',
    'JUNIE_GROK_API_KEY',
    'JUNIE_META_API_KEY',
    'JUNIE_OPENROUTER_API_KEY',
    'JUNIE_LITELLM_URL',
    'JUNIE_LITELLM_API_KEY',
    'JUNIE_HOME',
    'JUNIE_MODEL',
    'JUNIE_LLM_PROVIDER',
    'JUNIE_EFFORT',
    'JUNIE_CONFIG_LOCATION',
    'JUNIE_CONFIG_DEFAULT_LOCATIONS',
    'JUNIE_MODEL_LOCATIONS',
    'JUNIE_MODEL_DEFAULT_LOCATIONS',
    'JUNIE_MCP_LOCATIONS',
    'JUNIE_MCP_DEFAULT_LOCATIONS',
    'JUNIE_GUIDELINES_FILENAME',
  ],
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['--acp=true', '--skip-update-check'],
    env,
  }),
  checkSignIn: async ({ handshake }) => {
    await handshake();
    // Neither an initialize authMethods list nor a configured key validates credentials.
    return readiness(
      'unknown',
      'Junie started. Authentication is verified when a task runs. Run junie and use /account to configure your account or model provider.'
    );
  },
  mcpServerOf: (call) => {
    // Junie 3959.5 identifies MCP permissions as server/tool with this marker.
    if (call._meta?.is_mcp_tool_call !== true || !call.title) return undefined;
    const separator = call.title.indexOf('/');
    return separator > 0 && separator < call.title.length - 1
      ? call.title.slice(0, separator)
      : undefined;
  },
};

export function createJunieAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(junieAcp, options);
}
