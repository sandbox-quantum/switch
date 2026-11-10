import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { ACP_CANCELLED, type AcpPermissionRequest } from '../acp/protocol';
import { execProvider } from '../provider-process';
import { commandOutput, readiness, signInWith, type ProviderReadiness } from '../readiness';

export const AUGGIE_LOGIN = 'auggie login';
/** What `auggie account status` prints signed out (0.37.0, on stderr, exit 1). */
const SIGNED_OUT =
  /not (?:currently )?(?:logged|signed) in|run 'auggie login'|authentication required/i;

/**
 * The permission request Auggie sends, outside any tool call, before it
 * indexes a workspace it has no stored answer for.
 */
export const AUGGIE_INDEXING_PERMISSION = 'workspace-indexing-permission';

/**
 * Reads `auggie account status --json`. Signed out it exits 1 and says so;
 * signed in it exits 0 with the account's credit balance. Nothing it printed
 * is returned, so no account detail reaches readiness.
 */
export function parseAuggieStatus(output: string, exitedCleanly: boolean): ProviderReadiness {
  if (SIGNED_OUT.test(output)) return readiness('unauthenticated', signInWith(AUGGIE_LOGIN));
  if (exitedCleanly) return readiness('authenticated', 'Signed in.');
  return readiness(
    'unknown',
    'Could not verify authentication. Check provider setup and try again.'
  );
}

/**
 * Auggie's indexing consent, which 0.37.0 asks at the start of the first turn
 * in a workspace it has no stored answer for. Indexing uploads the workspace
 * to Augment, so Switch never grants it, and asking would hold up that first
 * turn (in full access, a request for work no one asked for). It is skipped for
 * this session, in every runtime mode, and nothing is written to Auggie's
 * settings: the generic policy would offer "Always index" as "for this
 * session", which Auggie stores for good. A workspace the owner chose
 * "Always index" for in `auggie` itself is never asked about, and is indexed.
 */
function skipIndexing(request: AcpPermissionRequest): Promise<unknown> {
  const skip = request.options.find((o) => o.kind === 'reject_once');
  // Auggie takes a cancelled prompt as "skip for this session" too.
  return Promise.resolve(
    skip ? { outcome: { outcome: 'selected', optionId: skip.optionId } } : ACP_CANCELLED
  );
}

/**
 * Augment Code's `auggie --acp`. Its `default` and `ask` modes are workflows,
 * not permission levels, so the session stays in its own mode and every
 * runtime mode is the adapter's answer to Auggie's per-tool requests.
 */
export const auggieAcp: AcpProviderHooks = {
  provider: 'auggie',
  label: 'Auggie CLI',
  defaultBinary: 'auggie',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  // `--allow-indexing` is deliberately not passed: see `skipIndexing`.
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['--acp'], env }),
  loginCommand: AUGGIE_LOGIN,
  // A headless machine signs in with the session JSON in place of
  // ~/.augment/session.json. Auto-update is turned off so a running host is
  // not upgraded under its sessions.
  inheritEnv: ['AUGMENT_SESSION_AUTH', 'AUGMENT_DISABLE_AUTO_UPDATE'],
  // Auggie offers no `authenticate` over ACP (`authMethods: []`): signed out,
  // `session/new` fails with "Authentication required". `account status`
  // answers from the same session, given or stored, and never prints it,
  // unlike `token print`.
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    try {
      const { stdout, stderr } = await execProvider(binaryPath, ['account', 'status', '--json'], {
        cwd,
        env,
        // It starts a large Node bundle and asks Augment's API: well over 15 s
        // on a busy Windows machine. Kept under the 35 s a readiness probe gets.
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });
      return parseAuggieStatus(`${stdout}\n${stderr}`, true);
    } catch (error) {
      const { stderr } = error as { stderr?: unknown };
      return parseAuggieStatus(
        `${commandOutput(error)}\n${typeof stderr === 'string' ? stderr : ''}`,
        false
      );
    }
  },
  // 0.37.0 maps `http` servers, headers included, in `session/new`, but its
  // `initialize` leaves `mcpCapabilities` out.
  mcpCapabilities: { http: true },
  permission: (_context, request) =>
    request.toolCall.toolCallId === AUGGIE_INDEXING_PERMISSION ? skipIndexing(request) : undefined,
};

export function createAuggieAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(auggieAcp, options);
}
