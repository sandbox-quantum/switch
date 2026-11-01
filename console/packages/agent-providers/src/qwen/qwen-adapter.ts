import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness } from '../readiness';

export const qwenAcp: AcpProviderHooks = {
  provider: 'qwen',
  label: 'Qwen Code',
  defaultBinary: 'qwen',

  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },

  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['--acp'],
    env,
  }),

  loginCommand: 'qwen',

  checkSignIn: async ({ handshake }) => {
    await handshake();

    return readiness(
      'unknown',
      'Qwen Code ACP initialized, but authentication status could not be confirmed.'
    );
  },

  promptCapabilities: {
    image: true,
    audio: true,
    embeddedContext: true,
  },

  sessionMode: (runtimeMode) => {
    switch (runtimeMode) {
      case 'full-access':
        return 'yolo';
      case 'auto-accept-edits':
        return 'auto-edit';
      case 'auto':
        return 'auto';
      case 'approval-required':
        return 'default';
    }
  },

  nativeSessionIdPrefix: {
    prefix: 'acp:qwen:',
    legacyMessage:
      'This conversation belongs to the previous Qwen runtime. Start a fresh ACP conversation; the existing transcript is preserved.',
  },
};

export function createQwenAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(qwenAcp, options);
}
