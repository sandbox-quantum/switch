import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import type { AcpToolCall } from '../acp/protocol';
import { execProvider } from '../provider-process';
import { commandOutput, readiness, signInWith, type ProviderReadiness } from '../readiness';

const KIRO_LOGIN = 'kiro-cli login';
const UNVERIFIED = 'Could not verify authentication. Check provider setup and try again.';

/** Reads `kiro-cli whoami --format json`, which prints `{"account":null}` when signed out. */
export function parseKiroWhoami(output: string): ProviderReadiness {
  let whoami: unknown;
  try {
    whoami = JSON.parse(output.trim());
  } catch {
    return readiness('unknown', UNVERIFIED);
  }
  if (typeof whoami !== 'object' || whoami === null) return readiness('unknown', UNVERIFIED);
  const { accountType } = whoami as { accountType?: unknown };
  if (typeof accountType === 'string' && accountType)
    return readiness('authenticated', `Signed in to Kiro (${accountType}).`);
  if ('account' in whoami && (whoami as { account: unknown }).account === null)
    return readiness('unauthenticated', signInWith(KIRO_LOGIN));
  return readiness('unknown', UNVERIFIED);
}

/** Kiro's own tool-call metadata: v2 and v3 of its ACP server name things differently. */
function kiroMeta(toolCall: AcpToolCall): Record<string, unknown> {
  const kiro = (toolCall._meta as { kiro?: unknown } | undefined)?.kiro;
  return typeof kiro === 'object' && kiro !== null ? (kiro as Record<string, unknown>) : {};
}

/** Kiro CLI's `kiro-cli acp`, on whichever agent engine the installed CLI defaults to. */
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
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['acp'], env }),
  loginCommand: KIRO_LOGIN,
  // `whoami` reads the stored sign-in and never starts one; it exits 1 when
  // signed out, still printing its JSON.
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
      output = commandOutput(error);
    }
    return parseKiroWhoami(output);
  },
  // Kiro's modes are agents and workflows (kiro_default, kiro_planner; vibe,
  // spec), not permission levels, so the session keeps the one the person
  // configured and the runtime mode is enforced on its permission requests.
  // Kiro has no reviewer of its own, so auto mode asks the way
  // approval-required does.
  mcpServerOf: (toolCall) => {
    const { mcpServerName, serverName } = kiroMeta(toolCall);
    const server = mcpServerName ?? serverName;
    return typeof server === 'string' && server ? server : undefined;
  },
  itemType: (toolCall) => {
    const { toolName, kind } = kiroMeta(toolCall);
    return toolName === 'subagent' || kind === 'agent-subtask' ? 'subagent' : undefined;
  },
};

export function createKiroAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(kiroAcp, options);
}
