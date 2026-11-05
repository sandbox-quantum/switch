import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createKiroAdapter, parseKiroWhoami } from './kiro-acp';

describeConformance('kiro', {
  createAdapter: async () => createKiroAdapter(),
  unavailableReason: async () => {
    const version = spawnSync('kiro-cli', ['--version'], { encoding: 'utf8' });
    if (version.error || version.status !== 0) return 'Kiro CLI is not installed';
    const account = spawnSync('kiro-cli', ['whoami', '--format', 'json'], {
      encoding: 'utf8',
    });
    if (account.error || account.status !== 0 || !account.stdout.trim())
      return 'Kiro CLI account status is unavailable';
    const status = parseKiroWhoami(account.stdout).status;
    return status === 'authenticated' ? null : `Kiro CLI account status is ${status}`;
  },
  mcpServers: { echo: echoMcpServerSpec() },
});
