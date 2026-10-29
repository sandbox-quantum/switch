import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createGooseAdapter } from './goose-adapter';

describeConformance('goose', {
  createAdapter: async () => createGooseAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('goose', ['info'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0
      ? 'the Goose CLI binary is not available or not configured'
      : null;
  },
  skip: {
    'user-input':
      'Goose asks user questions via ACP form elicitation, which the generic ACP adapter does not advertise.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.GOOSE_PROVIDER
    ? {
        env: {
          GOOSE_PROVIDER: process.env.GOOSE_PROVIDER,
          ...(process.env.GOOSE_MODEL ? { GOOSE_MODEL: process.env.GOOSE_MODEL } : {}),
        },
      }
    : {}),
});
