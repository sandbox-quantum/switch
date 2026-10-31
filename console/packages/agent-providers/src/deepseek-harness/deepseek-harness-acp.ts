import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';

export const DSH_LOGIN = 'dsh auth login';

export const deepseekHarnessAcp: AcpProviderHooks = {
  provider: 'deepseek-harness',
  label: 'DeepSeek Harness',
  defaultBinary: 'dsh',
  capabilities: {
    modelSwitchInSession: false,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['--profile', 'acp'],
    env,
  }),
  loginCommand: DSH_LOGIN,
  inheritEnv: ['DEEPSEEK_API_KEY'],
  checkSignIn: async ({ handshake, env }) => {
    if (env.DEEPSEEK_API_KEY?.trim()) {
      return readiness('authenticated', 'Signs in with the DeepSeek API key it was given.');
    }
    try {
      const result = await handshake();
      if (Array.isArray(result.authMethods)) {
        if (result.authMethods.length > 0) {
          return readiness('unauthenticated', signInWith(DSH_LOGIN));
        }
        return readiness('authenticated', 'Signed in to DeepSeek Harness.');
      }
      return readiness('unknown', signInWith(DSH_LOGIN));
    } catch (error) {
      if (/sign.?in|auth|unauthenticated|unauthorized|login/i.test(String(error))) {
        return readiness('unauthenticated', signInWith(DSH_LOGIN));
      }
      return readiness('unknown', signInWith(DSH_LOGIN));
    }
  },
  itemType: (toolCall) => {
    const title = toolCall.title?.toLowerCase();
    if (title === 'write' || title === 'edit') return 'file_change';
    if (title === 'bash' || title === 'command' || title === 'exec') return 'command_execution';
    return undefined;
  },
};

export function createDeepseekHarnessAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(deepseekHarnessAcp, options);
}
