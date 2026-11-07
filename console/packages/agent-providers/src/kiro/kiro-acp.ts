import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import type { AcpToolCall } from '../acp/protocol';
import type { ItemType } from '../events';
import { execProvider } from '../provider-process';
import { commandOutput, readiness, signInWith, type ProviderReadiness } from '../readiness';

const KIRO_LOGIN = 'kiro-cli login';
const SIGNED_OUT = /not logged in|not signed in|no account|unauthenticated/i;

/**
 * Reads `kiro-cli whoami`, which answers in two shapes (both verified against
 * the real CLI, 3.0.0): JSON with `--format json` — signed out it is just
 * `{"account":null}`; signed in it carries `email`/`accountType` and no
 * `account` key at all — and plain text ("Logged in with Builder ID", an
 * `Email:` line). `whoami` only ever reports the sign-in; it never starts
 * one, so it is safe to poll.
 */
export function parseKiroWhoami(output: string): ProviderReadiness {
  const text = output.trim();
  try {
    const result: unknown = JSON.parse(text);
    if (result && typeof result === 'object') {
      const record = result as { account?: unknown; email?: unknown };
      if ('account' in record) {
        if (record.account === null) return readiness('unauthenticated', signInWith(KIRO_LOGIN));
        if (record.account && typeof record.account === 'object')
          return readiness('authenticated', 'Signed in to Kiro CLI.');
      }
      if (typeof record.email === 'string' && record.email.length > 0)
        return readiness('authenticated', `Signed in to Kiro CLI as ${record.email}.`);
    }
  } catch {
    // Not the JSON form; the plain form is read below.
  }
  if (SIGNED_OUT.test(text)) return readiness('unauthenticated', signInWith(KIRO_LOGIN));
  const email = text.match(/Email(?:[ \t]*:[ \t]*|[ \t]+)(.+)/i)?.[1]?.trim();
  if (/logged in with/i.test(text) || email)
    return readiness(
      'authenticated',
      email ? `Signed in to Kiro CLI as ${email}.` : 'Signed in to Kiro CLI.'
    );
  return readiness(
    'unknown',
    'Could not verify Kiro CLI authentication. Check provider setup and try again.'
  );
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === 'object' ? (field as Record<string, unknown>) : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

/**
 * The MCP server a Kiro tool call belongs to. Verified against the real CLI
 * (3.0.0, 2026-11-05): a permission request for an MCP tool carries
 * `_meta.kiro.mcpTool.identity.serverName`, the tool call itself carries
 * `_meta.kiro.serverName`, and both name the tool in `rawInput.tool_id` as
 * `<server>::<tool>` under a `@<server>/<tool>` title. Naming the server is
 * what lets the adapter auto-approve the session's own registered servers
 * instead of stopping the turn to ask about them.
 */
export function kiroMcpServerOf(toolCall: AcpToolCall): string | undefined {
  const kiro = recordField(toolCall._meta, 'kiro');
  const identity = recordField(recordField(kiro, 'mcpTool'), 'identity');
  const fromMeta = stringField(identity, 'serverName') ?? stringField(kiro, 'serverName');
  if (fromMeta) return fromMeta;
  const toolId = stringField(toolCall.rawInput, 'tool_id');
  const namespaced = toolId?.split('::');
  if (namespaced && namespaced.length === 2 && namespaced[0]) return namespaced[0];
  const title = toolCall.title?.match(/^@([^/]+)\//);
  return title?.[1];
}

/**
 * Kiro runs delegated work as an ordinary tool call; the delegation is only
 * visible in the call itself (verified against the real CLI, 3.0.0,
 * 2026-11-05): its id starts `invoke_subagent_`, its `_meta.kiro.kind` is
 * `agent-subtask`, and its title is `Sub-agent: <name>`. Map exactly those
 * calls to the subagent item type the Console renders as a nested agent.
 * Tool calls the subagent itself makes carry the `agentSubtaskId` but not
 * the `agent-subtask` kind, so they keep their own types.
 */
export function kiroItemType(toolCall: AcpToolCall): ItemType | undefined {
  const kiro = recordField(toolCall._meta, 'kiro');
  if (stringField(kiro, 'kind') === 'agent-subtask') return 'subagent';
  if (toolCall.toolCallId.startsWith('invoke_subagent_')) return 'subagent';
  const toolId = stringField(toolCall.rawInput, 'tool_id');
  const name = toolId?.split('::').pop() ?? stringField(toolCall.rawInput, '_toolName');
  if (name === 'task' || (name !== undefined && /subagent/i.test(name))) return 'subagent';
  if (toolCall.title !== undefined && /sub-?agent/i.test(toolCall.title)) return 'subagent';
  return undefined;
}

/** Kiro CLI's `kiro-cli acp`, with the sign-in the CLI owns (`kiro-cli login`). */
export const kiroAcp: AcpProviderHooks = {
  provider: 'kiro',
  label: 'Kiro CLI',
  defaultBinary: 'kiro-cli',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  // No `--agent-engine` pin: the CLI chooses the harness itself (the saved
  // `acp.agentEngine` setting, else V3 where the machine supports it and V2
  // for clients that still need it), and the generic adapter works from the
  // capabilities the agent advertises at the handshake, not a version guess.
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['acp'], env }),
  loginCommand: KIRO_LOGIN,
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    let output: string;
    try {
      output = (
        await execProvider(binaryPath, ['whoami', '--format', 'json'], {
          cwd,
          env,
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      // A signed-out `whoami` exits non-zero with its answer on the streams;
      // that answer, not the exit, is what the parse reads.
      output = commandOutput(error);
    }
    return parseKiroWhoami(output);
  },
  // Kiro advertises image prompts at the handshake; naming them here keeps
  // them working on a build whose advertisement lags the CLI's support.
  promptCapabilities: { image: true },
  mcpServerOf: kiroMcpServerOf,
  itemType: kiroItemType,
  // No `sessionMode`: Kiro's ACP modes are its agent configurations, not
  // permission levels, so the session keeps the agent's own default mode and
  // Switch enforces the runtime mode on its permission requests.
  // No `authMethodId`: a signed-out Kiro answers `initialize` with the one
  // sign-in method it wants used, so there is no id to name here without
  // guessing one the CLI never published.
};

export function createKiroAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(kiroAcp, options);
}
