import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createCursorAdapter } from './cursor-adapter';

describeConformance('cursor', {
  createAdapter: async () => createCursorAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('agent', ['acp', '--help'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0
      ? 'the Cursor agent ACP binary is not available'
      : null;
  },
  skip: {
    'user-input':
      'Installed Cursor default model does not expose AskQuestion in agent or plan mode; protocol handlers are covered with wire-level tests and prose questions with Mattermost.',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  // The harness hands the CLI a minimal environment, so a key in the shell
  // would not reach it and Cursor would fall back to a browser sign-in.
  ...(process.env.CURSOR_API_KEY ? { env: { CURSOR_API_KEY: process.env.CURSOR_API_KEY } } : {}),
});
