import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';

export const QWEN_LOGIN = 'qwen';

/** Qwen Code's `qwen --acp`, a Gemini CLI fork with ACP support. */
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
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['--acp'], env }),
  loginCommand: QWEN_LOGIN,
  // Qwen Code stores its auth in ~/.qwen/settings.json, configured via /auth
  // inside a session. It supports API keys via environment variables or its
  // settings file. The handshake check catches the unauthenticated case.
  checkSignIn: async ({ handshake }) => {
    try {
      const result = await handshake();
      // If the handshake succeeds, the CLI is functional. Qwen Code's auth is
      // settings-file based and does not surface a separate unauthenticated
      // state in the initialize response; a successful handshake means it can
      // reach its model endpoint.
      if (result.authMethods?.length) {
        return readiness('unauthenticated', signInWith(QWEN_LOGIN));
      }
      return readiness('authenticated', 'Signed in to Qwen Code.');
    } catch (error) {
      if (/auth|sign.?in|unauthenticated|unauthorized|api.?key/i.test(String(error)))
        return readiness('unauthenticated', signInWith(QWEN_LOGIN));
      throw error;
    }
  },
  // Qwen Code (a Gemini CLI fork) uses the same permission-level mode names as
  // Antigravity: default, auto_edit, and yolo. Setting the mode explicitly
  // ensures session/request_permission is sent for tools that need approval
  // (see QwenLM/qwen-code#11887 — running with no explicit mode defaults to the
  // LLM classifier, which auto-approves; setting an explicit mode fixes this).
  sessionMode: (runtimeMode) => {
    switch (runtimeMode) {
      case 'full-access':
        return 'yolo';
      case 'auto-accept-edits':
      case 'auto':
        return 'auto_edit';
      case 'approval-required':
        return 'default';
    }
  },
  // Qwen Code passes API keys through these environment variables.
  inheritEnv: ['DASHSCOPE_API_KEY', 'QWENCLOUD_API_KEY', 'QWENCLOUD_TOKEN_PLAN_API_KEY'],
};

export function createQwenAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(qwenAcp, options);
}
