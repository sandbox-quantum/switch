import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createJunieAdapter } from './junie-adapter';

describeConformance('junie', {
  createAdapter: async () => createJunieAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('junie', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the junie binary is not on PATH' : null;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  skip: {
    'approval-required':
      'Junie 26.11.3 starts every ACP session in auto-approve mode and never sends session/request_permission, so a shell command runs without asking',
    'approval-declined':
      'Junie 26.11.3 never sends session/request_permission in ACP mode, so there is nothing to decline',
  },
  ...(process.env.JUNIE_TIMEOUT_MS ? { timeoutMs: Number(process.env.JUNIE_TIMEOUT_MS) } : {}),
  ...(process.env.JUNIE_MODEL ? { model: { id: process.env.JUNIE_MODEL } } : {}),
  ...(process.env.JUNIE_API_KEY ? { env: { JUNIE_API_KEY: process.env.JUNIE_API_KEY } } : {}),
});
