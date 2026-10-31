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
  mcpServers: { echo: echoMcpServerSpec() },
  env: {
    // The harness's minimal environment has no home directory on Windows
    // (only POSIX `HOME`), so Cline can't find its own config and refuses
    // every session as unauthenticated.
    ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
    ...(process.env.CLINE_API_KEY ? { CLINE_API_KEY: process.env.CLINE_API_KEY } : {}),
    // In ACP mode Cline ignores its saved default provider/model, so without
    // these the suite would run on the `cline` provider regardless of what's
    // configured on the machine.
    ...(process.env.CLINE_PROVIDER ? { CLINE_PROVIDER: process.env.CLINE_PROVIDER } : {}),
    ...(process.env.CLINE_MODEL ? { CLINE_MODEL: process.env.CLINE_MODEL } : {}),
  },
});
