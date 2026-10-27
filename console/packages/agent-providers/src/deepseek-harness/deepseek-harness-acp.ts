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
  checkSignIn: async ({ env }) => {
    if (env.DEEPSEEK_API_KEY?.trim()) {
      return readiness('authenticated', 'Signs in with the DeepSeek API key it was given.');
    }
    return readiness('unknown', signInWith(DSH_LOGIN));
  },
};

export function createDeepseekHarnessAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(deepseekHarnessAcp, options);
}
