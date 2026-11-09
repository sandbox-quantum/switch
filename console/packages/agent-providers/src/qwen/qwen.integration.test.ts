import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createQwenAdapter } from './qwen-acp';

describeConformance('qwen', {
  createAdapter: async () => createQwenAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('qwen', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the Qwen binary is not on PATH' : null;
  },
  skip: {
    // Documenting known approval request bug upstream per issue #782 / QwenLM/qwen-code#11887
    'approval-required':
      'Qwen Code upstream issue #11887: ACP mode may execute tools without emitting permission requests on certain prompt shapes.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.DASHSCOPE_API_KEY ? { env: { DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY } } : {}),
});
