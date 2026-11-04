import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createClineAdapter } from './cline-adapter';

describeConformance('cline', {
  createAdapter: async () => createClineAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('cline', ['--version'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    return probe.error || probe.status !== 0 ? 'the Cline CLI is not on PATH' : null;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  // The harness hands the CLI a minimal environment, so a key in the shell
  // would not reach it and Cline would refuse to start a session.
  ...(process.env.CLINE_API_KEY ? { env: { CLINE_API_KEY: process.env.CLINE_API_KEY } } : {}),
});
