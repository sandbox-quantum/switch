import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks, AcpSessionContext } from '../acp/hooks';
import { ACP_CANCELLED, type AcpPermissionRequest } from '../acp/protocol';
import { execProvider } from '../provider-process';
import { readiness, signInWith, type ProviderReadiness } from '../readiness';

export const AUGGIE_LOGIN = 'auggie login';
const SIGNED_OUT =
  /not (?:currently )?(?:logged|signed) in|run ['`"]?auggie login['`"]?|no (?:stored |authentication )?(?:session|token)|(?:login|authentication) required/i;

/**
 * The permission request Auggie sends before indexing a workspace.
 */
export const AUGGIE_INDEXING_PERMISSION = 'workspace-indexing-permission';

/** Reads environment-supplied session JSON (e.g. for headless or CI environments). */
export function parseAuggieSession(output: string): ProviderReadiness {
  try {
    // 0.36.0/0.37.0 may wrap JSON in SESSION= or TOKEN= lines
    const assignment = output.split(/\r?\n/).find((line) => /^(?:SESSION|TOKEN)=/.test(line));
    const session: unknown = JSON.parse(
      assignment ? assignment.replace(/^(?:SESSION|TOKEN)=\s*/, '') : output.trim()
    );
    if (
      typeof session === 'object' &&
      session !== null &&
      'accessToken' in session &&
      typeof session.accessToken === 'string' &&
      session.accessToken.trim() &&
      'tenantURL' in session &&
      typeof session.tenantURL === 'string' &&
      session.tenantURL.trim()
    )
      return readiness('authenticated', 'Auggie has a stored authentication session.');
  } catch {
    if (!SIGNED_OUT.test(output))
      return readiness(
        'unknown',
        'Could not read Auggie authentication. Check CLI setup and retry.'
      );
  }
  return readiness('unauthenticated', signInWith(AUGGIE_LOGIN));
}

/**
 * Reads `auggie account status --json`. Signed out, it exits 1 and says so
 * on stderr; signed in, it exits 0 with account status JSON. It never prints
 * raw credentials.
 */
export function parseAuggieAccountStatus(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): ProviderReadiness {
  const combined = `${result.stdout}\n${result.stderr}`;
  if (SIGNED_OUT.test(combined)) return readiness('unauthenticated', signInWith(AUGGIE_LOGIN));
  if (result.exitCode === 0) return readiness('authenticated', 'Signed in.');
  return readiness(
    'unknown',
    'Could not verify authentication. Check provider setup and try again.'
  );
}

/**
 * Auggie indexing consent. Indexing uploads the workspace to Augment's cloud,
 * so it is presented for explicit user decision in every runtime mode, session-scoped:
 * "Always index" and "Never index" are not offered to avoid mutating persistent CLI settings.
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

/** Auggie's native ACP agent with loopback MCP and safe indexing consent. */
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
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['--acp'],
    env,
  }),
  loginCommand: AUGGIE_LOGIN,
  inheritEnv: ['AUGMENT_SESSION_AUTH', 'AUGMENT_DISABLE_AUTO_UPDATE'],
  // 0.36.0/0.37.0 accepts HTTP MCP entries (including headers) in session/new,
  // but omits mcpCapabilities from initialize.
  mcpCapabilities: { http: true },
  promptCapabilities: { image: true },
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    // Check supplied session JSON first (for headless/container environments)
    if (env.AUGMENT_SESSION_AUTH?.trim()) return parseAuggieSession(env.AUGMENT_SESSION_AUTH);
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
  permission: (context, request) =>
    request.toolCall.toolCallId === AUGGIE_INDEXING_PERMISSION
      ? indexingPermission(context, request)
      : undefined,
};

export function createAuggieAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(auggieAcp, options);
}
