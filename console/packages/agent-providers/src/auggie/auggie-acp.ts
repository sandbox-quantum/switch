import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { ACP_CANCELLED } from '../acp/protocol';
import { readiness, signInWith } from '../readiness';

export const AUGGIE_LOGIN = 'auggie login';

/**
 * The tools that change files or run commands. Auggie 0.37 runs every tool
 * without asking unless a permission rule says `ask-user`, and it has no
 * switch for that either way, so each session starts with an `ask-user` rule
 * for these. Auggie then asks before each one, and the adapter answers for the
 * runtime mode: full access allows everything, auto-accept-edits allows edits,
 * and anything else goes to a person. Reading, searching and Auggie's own task
 * list still run without asking. Rules match the exact tool name; a name the
 * running version lacks matches nothing.
 */
export const AUGGIE_ASK_FIRST_TOOLS = [
  'launch-process',
  'write-process',
  'str-replace-editor',
  'save-file',
  'remove-files',
  'apply_patch',
  // The compact tool set Auggie uses instead when Augment's server turns it on.
  'bash',
  'edit',
  'write',
] as const;

/** The permission request Auggie sends at session start to index the workspace. */
const INDEXING_PERMISSION = 'workspace-indexing-permission';

interface AuggieSession {
  accessToken?: unknown;
  tenantURL?: unknown;
  scopes?: unknown;
}

/** Whether `json` is a session Auggie 0.37 accepts: a token, a tenant URL and a scopes list. */
function isAuggieSession(json: string | undefined): boolean {
  if (!json?.trim()) return false;
  try {
    const session = JSON.parse(json) as AuggieSession;
    return Boolean(session.accessToken && session.tenantURL && Array.isArray(session.scopes));
  } catch {
    return false;
  }
}

/**
 * Whether Auggie has a session to sign in with, read where Auggie 0.37 reads
 * it: `AUGMENT_SESSION_AUTH`, then `~/.augment/session.json`, which
 * `auggie login` writes. Nothing is sent, so a session it finds is not proven
 * valid until a turn runs.
 */
export async function auggieSessionSource(
  env: Record<string, string>
): Promise<'environment' | 'file' | undefined> {
  if (isAuggieSession(env.AUGMENT_SESSION_AUTH)) return 'environment';
  const file = join(env.HOME || homedir(), '.augment', 'session.json');
  const json = await readFile(file, 'utf8').catch(() => undefined);
  return isAuggieSession(json) ? 'file' : undefined;
}

/**
 * Augment Code's Auggie, `auggie --acp`. It signs in with the session
 * `auggie login` saves or with `AUGMENT_SESSION_AUTH`, and offers no
 * `authenticate` method over ACP: `session/new` refuses with "Authentication
 * required" until one of them is there.
 */
export const auggieAcp: AcpProviderHooks = {
  provider: 'auggie',
  label: 'Auggie',
  defaultBinary: 'auggie',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    // Auggie's question tool is not offered over ACP in 0.37.
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: [
      '--acp',
      ...AUGGIE_ASK_FIRST_TOOLS.flatMap((tool) => ['--permission', `${tool}:ask-user`]),
    ],
    env,
  }),
  loginCommand: AUGGIE_LOGIN,
  inheritEnv: ['AUGMENT_SESSION_AUTH'],
  checkSignIn: async ({ env }) => {
    const source = await auggieSessionSource(env);
    if (source === 'environment')
      return readiness('authenticated', 'Signs in with the session in AUGMENT_SESSION_AUTH.');
    return source === 'file'
      ? readiness('authenticated', 'Signed in.')
      : readiness('unauthenticated', signInWith(AUGGIE_LOGIN));
  },
  // auggie 0.37 registers HTTP MCP servers from `session/new` but does not
  // declare `mcpCapabilities.http`, and the Switch tools are served over HTTP.
  mcpCapabilities: { http: true },
  // Auggie's modes, `default` and `ask`, are workflows rather than permission
  // levels, so the session stays in `default` and the rules above ask.
  permission: (_context, request) => {
    // Indexing uploads the workspace to Augment, and its options include
    // "Always index", which Auggie saves for good. Switch never grants it: a
    // request outside a turn is already cancelled, which Auggie takes as
    // skipping; this answers one that lands inside a turn the same way. A
    // person who wants indexing allows the directory in Auggie itself.
    if (request.toolCall.toolCallId !== INDEXING_PERMISSION) return undefined;
    const skip = request.options.find((option) => option.kind === 'reject_once');
    return Promise.resolve(
      skip ? { outcome: { outcome: 'selected', optionId: skip.optionId } } : ACP_CANCELLED
    );
  },
};

export function createAuggieAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(auggieAcp, options);
}
