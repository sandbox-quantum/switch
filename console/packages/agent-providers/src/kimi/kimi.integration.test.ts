import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createKimiAdapter } from './kimi-adapter';

describeConformance('kimi', {
  createAdapter: async () => createKimiAdapter(),
  unavailableReason: async () => {
    let probe = spawnSync('kimi', ['--version'], { encoding: 'utf8' });
    let binary = 'kimi';
    if (probe.error || probe.status !== 0) {
      probe = spawnSync('kimi-code', ['--version'], { encoding: 'utf8' });
      binary = 'kimi-code';
    }
    if (probe.error || probe.status !== 0) {
      return 'the kimi binary is not on PATH';
    }
    const check = spawnSync(binary, ['-p', 'ping'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...(process.env.KIMI_API_KEY ? { KIMI_API_KEY: process.env.KIMI_API_KEY } : {}),
      },
      timeout: 10_000,
    });
    if (
      check.status !== 0 &&
      /subscription|pricing|unauthenticated|login|auth_error|not logged in/i.test(
        check.stderr || check.stdout
      )
    ) {
      return 'Kimi Code CLI requires an active subscription or API quota';
    }
    return null;
  },
  skip: {
    'user-input':
      'Kimi Code ACP does not expose an interactive ask-the-user question tool in ACP mode.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(process.env.KIMI_API_KEY ? { env: { KIMI_API_KEY: process.env.KIMI_API_KEY } } : {}),
  ...(process.env.MOONSHOT_API_KEY
    ? { env: { MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY } }
    : {}),
});
