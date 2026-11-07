import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { loginWontHelp, readiness } from '../readiness';
import { launchOpenHands, preflightOpenHands } from './launcher';
import { prepareOpenHandsMcpServers } from './mcp-config';

/**
 * Where OpenHands keeps everything it persists — the configured agent, its
 * conversations and the OpenHands Cloud sign-in: `OPENHANDS_PERSISTENCE_DIR`
 * when set, `~/.openhands` otherwise, as the CLI itself resolves it.
 */
export function openhandsHome(env: Record<string, string>): string {
  const configured = env.OPENHANDS_PERSISTENCE_DIR?.trim();
  if (configured) return configured;
  return join(env.HOME?.trim() || homedir(), '.openhands');
}

/**
 * Whether OpenHands can run a session on this machine, read from the state
 * the CLI itself keeps, so the check never starts a login or a session:
 *
 * - a configured agent: `agent_settings.json` naming an LLM model, which
 *   the first run of `openhands` writes and `openhands acp` loads — with no
 *   loadable agent the local ACP server refuses the session outright.
 *
 * A Cloud login alone does not configure a local agent. The CLI's own
 * preferences file (`cli_config.json`) does not either. A model setting is
 * necessary, although it does not prove that its credentials are valid.
 */
export async function openhandsSignedIn(env: Record<string, string>): Promise<boolean> {
  const home = openhandsHome(env);
  try {
    const settings = JSON.parse(await readFile(join(home, 'agent_settings.json'), 'utf8')) as {
      llm?: { model?: unknown };
    };
    if (typeof settings.llm?.model === 'string' && settings.llm.model.trim()) return true;
  } catch {
    // No readable agent settings.
  }
  return false;
}

/** OpenHands' `openhands acp`, the CLI's native ACP server. */
export const openhandsAcp: AcpProviderHooks = {
  provider: 'openhands',
  label: 'OpenHands CLI',
  defaultBinary: 'openhands',
  capabilities: {
    // The ACP server answers `session/new` with the session's modes but no
    // model list and no config options, and its `session/set_model` is a
    // no-op (CLI 1.16): the model a session runs is the one in OpenHands'
    // own settings. Claiming an in-session switch would silently do
    // nothing, so Switch does not offer one.
    modelSwitchInSession: false,
    steering: false,
    resume: true,
    approvals: true,
    // The agent's only client request is `session/request_permission`, for
    // its confirmation prompts; questions have no channel.
    userInput: false,
  },
  launch: launchOpenHands,
  prepareMcpServers: prepareOpenHandsMcpServers,
  maxRequestBytes: 16 * 1024 * 1024,
  loginCommand: 'openhands',
  // The one variable of OpenHands' a session host must pass through: a
  // session has to read the same home the sign-in check read. The LLM
  // variables are not inherited — `openhands acp` ignores them without
  // `--override-with-envs`, which Switch does not pass, and runs the
  // persisted agent instead.
  inheritEnv: ['OPENHANDS_PERSISTENCE_DIR'],
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    try {
      await preflightOpenHands({ binaryPath, cwd, env });
    } catch {
      // The compatibility check can fail on a path or child process error;
      // never surface those raw errors, which could contain private values.
      return loginWontHelp(
        readiness(
          'unconfigured',
          'OpenHands is unavailable or incompatible. Install Python-based OpenHands CLI 1.16.0 with SDK/tools 1.21.0 and agent-client-protocol >=0.8.1,<0.9.0 on the execution machine.'
        )
      );
    }
    return (await openhandsSignedIn(env))
      ? readiness('authenticated', 'Signed in.')
      : readiness(
          'unauthenticated',
          'OpenHands has no LLM configured on this machine. Run `openhands` once on the execution machine to set one up.'
        );
  },
  // OpenHands asks before an action in its confirmation modes, and Switch's
  // runtime modes map onto them. Auto-accept-edits stays always-ask: the
  // generic adapter answers edit requests itself in that mode, and the CLI
  // has no edits-only mode to hand the asking to. Auto mode hands the
  // asking to OpenHands' own LLM-based approval, its reviewer.
  sessionMode: (runtimeMode) => {
    switch (runtimeMode) {
      case 'full-access':
        return 'always-approve';
      case 'auto':
        return 'llm-approve';
      case 'auto-accept-edits':
      case 'approval-required':
        return 'always-ask';
    }
  },
};

export function createOpenHandsAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(openhandsAcp, options);
}
