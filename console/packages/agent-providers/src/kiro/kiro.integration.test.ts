import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createKiroAdapter } from './kiro-acp';

describeConformance('kiro', {
  createAdapter: async () => createKiroAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('kiro-cli', ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
    });

    return probe.error || probe.status !== 0
      ? 'Kiro CLI ACP is unavailable; install and authenticate kiro-cli to run this integration test'
      : null;
  },
  skip: {
    'steer-mid-turn': 'Kiro ACP adapter does not currently support mid-turn steering.',
    'user-input': 'Kiro ACP adapter does not currently support user-input requests.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
});
