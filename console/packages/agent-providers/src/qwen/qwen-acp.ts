import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
  // settings file.
  checkSignIn: async ({ handshake, env }) => {
    if (
      env.DASHSCOPE_API_KEY?.trim() ||
      env.OPENAI_API_KEY?.trim() ||
      env.QWENCLOUD_API_KEY?.trim() ||
      env.GEMINI_API_KEY?.trim() ||
      env.ANTHROPIC_API_KEY?.trim()
    ) {
      return readiness('authenticated', 'Signs in with the API key it was given.');
    }
    try {
      await handshake();
      const settingsPath = join(homedir(), '.qwen', 'settings.json');
      if (existsSync(settingsPath)) {
        const raw = await readFile(settingsPath, 'utf8');
        const settings = JSON.parse(raw);
        if (
          settings?.security?.auth?.selectedType ||
          settings?.security?.auth?.apiKey ||
          settings?.modelProviders?.length
        ) {
          return readiness('authenticated', 'Signed in to Qwen Code.');
        }
      }
      return readiness('unauthenticated', signInWith(QWEN_LOGIN));
    } catch (error) {
      if (/auth|sign.?in|unauthenticated|unauthorized|api.?key/i.test(String(error))) {
        return readiness('unauthenticated', signInWith(QWEN_LOGIN));
      }
      return readiness('unknown', signInWith(QWEN_LOGIN));
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
  mcpServerOf: (toolCall) => {
    const meta = toolCall._meta as
      | { is_mcp_tool_call?: boolean; mcp?: { server?: unknown } }
      | undefined;
    if (meta?.is_mcp_tool_call === true && typeof meta.mcp?.server === 'string') {
      return meta.mcp.server;
    }
    const rawInput = toolCall.rawInput as { tool_name?: string } | undefined;
    const toolName = rawInput?.tool_name ?? toolCall.title ?? '';
    if (toolName.includes('__')) return toolName.split('__')[0];
    const rawOutput = toolCall.rawOutput as { server_name?: string } | undefined;
    return typeof rawOutput?.server_name === 'string' ? rawOutput.server_name : undefined;
  },
  // Qwen Code passes API keys through these environment variables.
  inheritEnv: [
    'DASHSCOPE_API_KEY',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'GEMINI_API_KEY',
    'ANTHROPIC_API_KEY',
    'QWENCLOUD_API_KEY',
    'QWENCLOUD_TOKEN_PLAN_API_KEY',
  ],
};

export function createQwenAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(qwenAcp, options);
}
