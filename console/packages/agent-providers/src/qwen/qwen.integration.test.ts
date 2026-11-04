import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createQwenAdapter } from './qwen-acp';

describeConformance('qwen', {
  createAdapter: async () => createQwenAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('qwen', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the qwen binary is not on PATH';
    const hasKey = Boolean(
      process.env.DASHSCOPE_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.QWENCLOUD_API_KEY
    );
    if (hasKey) return null;
    const settingsPath = join(homedir(), '.qwen', 'settings.json');
    if (existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
        if (settings?.security?.auth?.apiKey || settings?.modelProviders?.length) {
          return null;
        }
      } catch {}
    }
    return 'qwen is not logged in; set DASHSCOPE_API_KEY, OPENAI_API_KEY, or run `qwen` to sign in';
  },
  // Qwen Code does not expose an AskQuestion tool in ACP mode; the conformance
  // suite's user-input scenario requires it.
  skip: {
    'user-input':
      'Qwen Code does not expose an interactive AskQuestion prompt in ACP mode (qwen --acp); the approval and tool scenarios pass without it.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  env: {
    ...(process.env.DASHSCOPE_API_KEY ? { DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY } : {}),
    ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}),
    ...(process.env.GEMINI_API_KEY ? { GEMINI_API_KEY: process.env.GEMINI_API_KEY } : {}),
    ...(process.env.QWENCLOUD_API_KEY ? { QWENCLOUD_API_KEY: process.env.QWENCLOUD_API_KEY } : {}),
  },
});
