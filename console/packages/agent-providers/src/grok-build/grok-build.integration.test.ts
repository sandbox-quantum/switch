import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createGrokBuildAdapter } from './grok-build-adapter';

describeConformance('grok-build', {
  createAdapter: async () => createGrokBuildAdapter(),
  unavailableReason: async () => {
    const probe = spawnSync('grok', ['--version'], { encoding: 'utf8' });
    return probe.error || probe.status !== 0 ? 'the grok binary is not on PATH' : null;
  },
  skip: {
    // Checked live against 1.0.70, 2026-11-04: no ask-the-user mechanism is
    // documented or was observed over ACP — no request.opened/user-input
    // event, no special tool item, for any prompt tried.
    'user-input':
      'Grok Build 1.0.70 has no documented or observed ask-the-user tool over ACP (checked 2026-11-04).',
    // Checked live against 1.0.70, 2026-11-04: declining a command_execution
    // approval ends the whole turn with stopReason "cancelled" rather than
    // letting the model see the rejection and reply in text — the item goes
    // to `failed` and the turn reports `interrupted`, never `completed`.
    'approval-declined':
      'Grok Build 1.0.70 ends the turn as cancelled when a tool call is declined, instead of continuing it so the model can acknowledge the rejection in text (checked 2026-11-04).',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  // The harness's minimal environment keeps HOME, so a prior `grok login`'s
  // cached token in ~/.grok/auth.json is found without any extra env; an
  // API key works the same way Cursor's does.
  ...(process.env.XAI_API_KEY ? { env: { XAI_API_KEY: process.env.XAI_API_KEY } } : {}),
});
