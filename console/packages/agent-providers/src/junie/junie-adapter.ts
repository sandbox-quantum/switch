import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import type { ItemType } from '../events';
import { readiness, signInWith } from '../readiness';

export const JUNIE_LOGIN = 'junie login';

export const junieAcp: AcpProviderHooks = {
  provider: 'junie',
  label: 'Junie',
  defaultBinary: 'junie',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['--acp=true'],
    env,
  }),
  loginCommand: JUNIE_LOGIN,
  inheritEnv: ['JUNIE_API_KEY'],
  checkSignIn: async ({ env, handshake, request, cwd }) => {
    if (
      env.JUNIE_API_KEY?.trim() ||
      env.ANTHROPIC_API_KEY?.trim() ||
      env.OPENAI_API_KEY?.trim() ||
      env.GOOGLE_API_KEY?.trim() ||
      env.GEMINI_API_KEY?.trim()
    ) {
      return readiness('authenticated', 'Signs in with the API key it was given.');
    }
    try {
      await handshake();
      await request('session/new', { cwd, mcpServers: [] });
      return readiness('authenticated', 'Signed in.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        /auth|login|unauthorized|not signed in|not logged in|forbidden|key/i.test(
          message
        )
      ) {
        return readiness('unauthenticated', signInWith(JUNIE_LOGIN));
      }
      return readiness(
        'unknown',
        'Could not verify authentication. Check provider setup and try again.'
      );
    }
  },
  mcpServerOf: (toolCall) => {
    const server = toolCall.rawInput?.providerIdentifier;
    if (typeof server === 'string' && server) return server;
    if (toolCall.title && toolCall.title.includes('__')) {
      const candidate = toolCall.title.split('__')[0]?.trim();
      if (candidate && !candidate.includes(' ')) return candidate;
    }
    return undefined;
  },
  itemType: (toolCall): ItemType | undefined => {
    if (
      toolCall.rawInput?._toolName === 'task' ||
      toolCall.title?.startsWith('Task:') ||
      toolCall.title?.startsWith('spawn_agent:')
    ) {
      return 'subagent';
    }
    return undefined;
  },
};

export function createJunieAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(junieAcp, options);
}
