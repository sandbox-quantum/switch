import { spawnSync } from 'node:child_process';
import { describeConformance, echoMcpServerSpec } from '../testing/index';
import { createAmpAdapter } from './amp-adapter';

const env: Record<string, string> = {};
if (process.env.AMP_API_KEY) env.AMP_API_KEY = process.env.AMP_API_KEY;
if (process.env.AMP_CLI_PATH) env.AMP_CLI_PATH = process.env.AMP_CLI_PATH;
// The harness hands the CLI a minimal environment; without AMP_CLI_PATH,
// amp-acp may not find a shell-installed Amp binary.
else {
  const amp = spawnSync('sh', ['-c', 'command -v amp'], { encoding: 'utf8' });
  const path = amp.stdout?.trim();
  if (amp.status === 0 && path) env.AMP_CLI_PATH = path;
}

describeConformance('amp', {
  createAdapter: async () => createAmpAdapter(),
  unavailableReason: async () => {
    // amp-acp with no args starts the ACP server and would hang, so only probe
    // that both binaries resolve on PATH.
    const which = spawnSync(
      'sh',
      ['-c', 'command -v amp-acp >/dev/null && command -v amp >/dev/null'],
      {
        encoding: 'utf8',
      }
    );
    if (which.status !== 0)
      return 'amp-acp or the Amp CLI is not on PATH (install amp-acp and the Amp CLI, then run amp login)';
    return null;
  },
  timeoutMs: 300_000,
  skip: {
    'approval-required':
      'Amp Neo runs tools without asking by default, and amp-acp 0.12.0 does not emit session/request_permission for Amp ask-permission rules (verified 2026-11-04: ask "*" blocks the tool in-thread but never opens an ACP permission request). Switch still maps approval-required to Amp default and full-access/auto to bypass.',
    'approval-declined':
      'Same as approval-required: amp-acp 0.12.0 has no ACP permission-request channel for Amp tool asks (2026-11-04).',
    'steer-mid-turn':
      "amp-acp 0.12.0 serializes prompts and only delivers the next turn after the active one ends; a long generation therefore never sees the mid-turn message before the 300 s deadline. Its _amp/session/steer next-turn extension is not wired through Switch's generic ACP adapter (2026-11-04).",
    'user-input':
      'amp-acp 0.12.0 has no ask-the-user ACP surface (2026-11-04); Amp modes are permission and effort selects, not questions.',
    subagent:
      'amp-acp 0.12.0 does not advertise a subagent ACP item type that the conformance harness can wait for (2026-11-04).',
  },
  mcpServers: { echo: echoMcpServerSpec() },
  ...(Object.keys(env).length > 0 ? { env } : {}),
});
