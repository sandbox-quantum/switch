import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createAuggieAdapter } from './auggie-adapter';

describeConformance('auggie', {
  createAdapter: async () => createAuggieAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('auggie', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the auggie binary is not on PATH' : null;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.AUGMENT_SESSION_AUTH
    ? { env: { AUGMENT_SESSION_AUTH: process.env.AUGMENT_SESSION_AUTH } }
    : {}),
});
