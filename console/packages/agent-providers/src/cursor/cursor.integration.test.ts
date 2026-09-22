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
});
