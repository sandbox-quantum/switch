import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks, AcpSessionContext } from '../acp/hooks';
import { ACP_CANCELLED, type AcpPermissionRequest } from '../acp/protocol';
import { execProvider } from '../provider-process';
import { readiness, signInWith, type ProviderReadiness } from '../readiness';

const AUGGIE_LOGIN = 'auggie login';
const SIGNED_OUT = /not (?:currently )?logged in|run 'auggie login'/i;

/**
 * The request Auggie sends, outside any tool call, before it indexes a
 * workspace it has no stored answer for.
 */
export const AUGGIE_INDEXING_PERMISSION = 'workspace-indexing-permission';

/**
 * Reads `auggie account status --json`. Signed out, it exits 1 and says so
 * on stderr; signed in, it exits 0 with the account's credit balance. It
 * never prints the session itself.
 */
export function parseAuggieAccountStatus(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): ProviderReadiness {
  if (SIGNED_OUT.test(`${result.stdout}\n${result.stderr}`))
    return readiness('unauthenticated', signInWith(AUGGIE_LOGIN));
  if (result.exitCode === 0) return readiness('authenticated', 'Signed in.');
  return readiness(
    'unknown',
    'Could not verify authentication. Check provider setup and try again.'
  );
}

/**
 * Auggie's indexing consent. Indexing uploads the workspace to Augment, so it
 * is the owner's choice in every runtime mode, full access included, and only
 * for this session: "Always index" and "Never index" would be written to
 * Auggie's settings for good.
 */
function indexingPermission(
  context: AcpSessionContext,
  request: AcpPermissionRequest
): Promise<unknown> {
  const option = (kind: string) => request.options.find((o) => o.kind === kind);
  const index = option('allow_once');
  const skip = option('reject_once');
  return context.requestDecision({
    requestType: 'tool_approval',
    title: request.toolCall.title ?? 'Workspace indexing',
    detail:
      'Auggie asks to index this workspace, which uploads its files to Augment for codebase retrieval.',
    options: [
      ...(index
        ? [
            {
              decision: 'accept' as const,
              label: index.name,
              response: { outcome: { outcome: 'selected', optionId: index.optionId } },
            },
          ]
        : []),
      ...(skip
        ? [
            {
              decision: 'decline' as const,
              label: skip.name,
              response: { outcome: { outcome: 'selected', optionId: skip.optionId } },
            },
          ]
        : []),
      // Auggie takes a cancelled prompt as "skip for this session".
      { decision: 'cancel' as const, label: 'Cancel', response: ACP_CANCELLED },
    ],
  });
}

/** Augment's `auggie --acp`. */
export const auggieAcp: AcpProviderHooks = {
  provider: 'auggie',
  label: 'Auggie',
  defaultBinary: 'auggie',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  // No flag allows every tool: Auggie asks over ACP for each one, and the
  // runtime mode answers there. `--allow-indexing` is not passed (see
  // `permission`).
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['--acp'], env }),
  loginCommand: AUGGIE_LOGIN,
  // The session JSON a headless machine signs in with, in place of
  // ~/.augment/session.json.
  inheritEnv: ['AUGMENT_SESSION_AUTH'],
  // Auggie offers no `authenticate` method over ACP: signed out, `session/new`
  // fails with "Authentication required" and the sign-in check says how to
  // fix it, so `authMethodId` is omitted.
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    try {
      const { stdout, stderr } = await execProvider(binaryPath, ['account', 'status', '--json'], {
        cwd,
        env,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      return parseAuggieAccountStatus({ exitCode: 0, stdout, stderr });
    } catch (error) {
      const failed = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      return parseAuggieAccountStatus({
        exitCode: typeof failed.code === 'number' ? failed.code : -1,
        stdout: typeof failed.stdout === 'string' ? failed.stdout : '',
        stderr: typeof failed.stderr === 'string' ? failed.stderr : '',
      });
    }
  },
  // Auggie 0.37.0 takes `http` servers, headers included, in `session/new`,
  // but its `initialize` leaves `mcpCapabilities` out.
  httpMcp: true,
  promptCapabilities: { image: true },
  permission: (context, request) =>
    request.toolCall.toolCallId === AUGGIE_INDEXING_PERMISSION
      ? indexingPermission(context, request)
      : undefined,
};

export function createAuggieAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(auggieAcp, options);
}
