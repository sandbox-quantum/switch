import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createQwenAdapter } from './qwen-acp';

describeConformance('qwen', {
  createAdapter: async () => createQwenAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('qwen', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the qwen binary is not on PATH' : null;
  },
  // Qwen Code does not expose an AskQuestion tool in ACP mode; the conformance
  // suite's user-input scenario requires it.
  skip: {
    'user-input':
      'Qwen Code does not expose an interactive AskQuestion prompt in ACP mode (qwen --acp); the approval and tool scenarios pass without it.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
});
