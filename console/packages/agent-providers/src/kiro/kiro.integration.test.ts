import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createKiroAdapter } from './kiro-acp';

describeConformance('kiro', {
  createAdapter: async () => createKiroAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('kiro-cli', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the kiro-cli binary is not on PATH' : null;
  },
  timeoutMs: 300_000,
  skip: {
    'user-input':
      'Kiro CLI V3 uses standard ACP tool permission requests and does not advertise user-input questions (v2.34.0, 2026-10-29).',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.KIRO_API_KEY ? { env: { KIRO_API_KEY: process.env.KIRO_API_KEY } } : {}),
});
