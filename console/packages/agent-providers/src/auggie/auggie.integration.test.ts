import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createAuggieAdapter } from './auggie-adapter';

describeConformance('auggie', {
  createAdapter: async () => createAuggieAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('auggie', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the auggie binary is not on PATH';
    const status = spawnSync('auggie', ['account', 'status', '--json'], { encoding: 'utf8' });
    return status.status === 0 ? null : 'auggie is not signed in (run auggie login)';
  },
  mcpServers: { echo: echoMcpServerSpec() },
  // The harness hands the CLI a minimal environment, so a session given in
  // the shell would not reach it otherwise.
  ...(process.env.AUGMENT_SESSION_AUTH
    ? { env: { AUGMENT_SESSION_AUTH: process.env.AUGMENT_SESSION_AUTH } }
    : {}),
});
