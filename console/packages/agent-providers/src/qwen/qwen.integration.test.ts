import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createQwenAdapter, qwenAcp } from './qwen-adapter';

// The harness hands the CLI a minimal environment, so the key and endpoint of
// a model provider set in the shell would not reach it.
const providerEnv = Object.fromEntries(
  ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'].flatMap((name) =>
    process.env[name] ? [[name, process.env[name]]] : []
  )
);

describeConformance('qwen', {
  createAdapter: async () => createQwenAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('qwen', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the Qwen Code binary (qwen) is not available';
    const { PATH = '', HOME = '' } = process.env;
    const signedIn = await checkAcpSignIn(qwenAcp, {
      binaryPath: 'qwen',
      cwd: tmpdir(),
      env: { PATH, HOME, ...providerEnv },
    });
    return signedIn.status === 'authenticated'
      ? null
      : `Qwen Code ${probe.stdout.trim()} is not signed in: ${signedIn.message}`;
  },
  mcpServers: { echo: echoMcpServerSpec() },
  env: providerEnv,
});
