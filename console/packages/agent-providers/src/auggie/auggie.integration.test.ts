import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createAuggieAdapter } from './auggie-acp';

describeConformance('auggie', {
  createAdapter: async () => createAuggieAdapter(),
  unavailableReason: async () => {
    const probe =
      process.platform === 'win32'
        ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'auggie --help'], { encoding: 'utf8' })
        : spawnSync('auggie', ['--help'], { encoding: 'utf8' });

    return probe.error || probe.status !== 0
      ? 'the Auggie CLI ACP binary is not available'
      : null;
  },
  skip: {
    'user-input': 'Auggie ACP has not advertised a user-input capability.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
});
