import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { checkAcpSignIn } from '../acp/acp-adapter';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createGooseAdapter, gooseAcp } from './goose-adapter';

// The harness hands the CLI a minimal environment, so the provider choice and
// key in the shell would not reach Goose without these.
const PASSED_THROUGH = [
  'GOOSE_PROVIDER',
  'GOOSE_MODEL',
  'GOOSE_DISABLE_KEYRING',
  'GOOGLE_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
];
const env = Object.fromEntries(
  PASSED_THROUGH.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : []))
);

describeConformance('goose', {
  createAdapter: async () => createGooseAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('goose', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'the goose binary is not on PATH';
    const readiness = await checkAcpSignIn(gooseAcp, {
      binaryPath: 'goose',
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    });
    return readiness.status === 'authenticated' ? null : readiness.message;
  },
  skip: {
    'user-input':
      'Goose 1.57.0 (2026-11-07) offers its model no ask-the-user tool: its tools are the developer extension (shell, write, edit, tree, analyze), delegate, load, apps and extension management, plus MCP servers.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  env,
});
