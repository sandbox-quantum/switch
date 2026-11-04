import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { clineProfile, clineSignedIn, createClineAdapter } from './cline-adapter';

describeConformance('cline', {
  createAdapter: async () => createClineAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('cline', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the cline binary is not on PATH';
    const env = process.env as Record<string, string>;
    if (!env.CLINE_API_KEY?.trim() && !(await clineSignedIn(clineProfile(env)))) {
      return 'no cline login or CLINE_API_KEY found; run `cline auth` or set CLINE_API_KEY';
    }
    return null;
  },
  skip: {
    'user-input': 'Cline CLI does not expose ACP user-input question capabilities.',
    subagent: 'Cline CLI does not support ACP subagent delegation.',
    'mcp-registered':
      'Cline CLI 3.0.74 does not declare agentCapabilities.mcpCapabilities.http in ACP initialize.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.CLINE_MODEL ? { model: { id: process.env.CLINE_MODEL } } : {}),
  ...(process.env.CLINE_API_KEY ? { env: { CLINE_API_KEY: process.env.CLINE_API_KEY } } : {}),
});
