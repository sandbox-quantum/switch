import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createClineAdapter } from './cline-adapter';

describeConformance('cline', {
  createAdapter: async () => createClineAdapter(),
  unavailableReason: async () => {
    // cline is npm-installed, so on Windows it's a `.cmd`, which spawnSync
    // cannot run without a shell.
    const probe = spawnSync('cline', ['--version'], { encoding: 'utf8', shell: true });
    return probe.error || probe.status !== 0 ? 'the cline binary is not on PATH' : null;
  },
  skip: {
    'user-input':
      'Cline answers clarifying questions in plain text: no user-input request fires over ACP (2026-11-07).',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  env: {
    ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
    ...(process.env.CLINE_API_KEY ? { CLINE_API_KEY: process.env.CLINE_API_KEY } : {}),
    ...(process.env.CLINE_PROVIDER ? { CLINE_PROVIDER: process.env.CLINE_PROVIDER } : {}),
    ...(process.env.CLINE_MODEL ? { CLINE_MODEL: process.env.CLINE_MODEL } : {}),
  },
});
