import { spawnSync } from 'node:child_process';
import { AGENT_ENV_VARS } from '../host/agent-env';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createGooseAdapter, gooseAcp, parseGooseInfo } from './goose-acp';

// The harness hands the CLI a minimal environment. Goose may take its
// provider, model and key from the shell, so those are passed through the way
// a session host passes them.
const env = Object.fromEntries(
  [...AGENT_ENV_VARS, ...(gooseAcp.inheritEnv ?? [])].flatMap((name) => {
    const value = process.env[name];
    return value ? [[name, value]] : [];
  })
);

describeConformance('goose', {
  createAdapter: async () => createGooseAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('goose', ['info', '--verbose'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    });
    if (probe.error) return 'the goose binary is not on PATH';
    return parseGooseInfo(probe.stdout ?? '').status === 'authenticated'
      ? null
      : 'goose has no model provider configured; run goose configure';
  },
  // Goose's model ids depend on the provider it is set up with, so the
  // suite uses its configured model unless one is named here.
  ...(process.env.GOOSE_CONFORMANCE_MODEL
    ? { model: { id: process.env.GOOSE_CONFORMANCE_MODEL } }
    : {}),
  skip: {
    'user-input':
      'goose 1.56.0 has no ask-the-user tool; it asks a question as plain text, and only MCP elicitations, which Switch does not advertise, would ask through the client (2026-10-27).',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  env,
});
