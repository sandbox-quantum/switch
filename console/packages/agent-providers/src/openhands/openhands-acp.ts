import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness } from '../readiness';

const OPENHANDS_LOGIN = 'openhands login';
const SIGNED_OUT = `OpenHands has no model set up on this machine. Run openhands and choose a model and API key in its settings, or sign in to OpenHands Cloud with ${OPENHANDS_LOGIN}.`;

/** Where OpenHands keeps its settings and, unless told otherwise, its conversations. */
function openhandsDirectory(env: Record<string, string>): string {
  return env.OPENHANDS_PERSISTENCE_DIR || join(env.HOME || homedir(), '.openhands');
}

/**
 * The model OpenHands sessions run: `llm.model` in the agent settings its
 * settings screen and `openhands login` save. Undefined when there are none,
 * which is when its ACP server refuses to start a session.
 */
export async function openhandsModel(env: Record<string, string>): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(join(openhandsDirectory(env), 'agent_settings.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const model = (JSON.parse(text) as { llm?: { model?: unknown } } | null)?.llm?.model;
    return typeof model === 'string' && model ? model : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The MCP servers OpenHands adds to every session from its own `mcp.json`,
 * those not turned off. A session's server of the same name replaces one.
 */
export async function openhandsMcpServers(env: Record<string, string>): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(openhandsDirectory(env), 'mcp.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let servers: unknown;
  try {
    servers = (JSON.parse(text) as { mcpServers?: unknown } | null)?.mcpServers;
  } catch {
    // OpenHands starts no session with an mcp.json it cannot read.
    return [];
  }
  if (!servers || typeof servers !== 'object') return [];
  return Object.entries(servers as Record<string, { enabled?: unknown } | null>)
    .filter(([, server]) => server?.enabled !== false)
    .map(([name]) => name);
}

/** The directory OpenHands keeps the conversation `id` in. */
export function openhandsConversation(env: Record<string, string>, id: string): string {
  const conversations =
    env.OPENHANDS_CONVERSATIONS_DIR || join(openhandsDirectory(env), 'conversations');
  return join(conversations, id.replaceAll('-', ''));
}

/** Whether OpenHands has saved the conversation `id`. */
async function savedConversation(env: Record<string, string>, id: string): Promise<boolean> {
  try {
    await access(join(openhandsConversation(env, id), 'base_state.json'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** The OpenHands CLI's `openhands acp`, which runs the model set in its own settings. */
export const openhandsAcp: AcpProviderHooks = {
  provider: 'openhands',
  label: 'OpenHands CLI',
  defaultBinary: 'openhands',
  capabilities: {
    modelSwitchInSession: false,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  // `--resume` with an id OpenHands never saved starts an empty conversation
  // under it, so such an id is left out: the session then starts under a new
  // id, which the adapter reports as a conversation it cannot resume.
  launch: async ({ binaryPath, env, resumeSessionId }) => ({
    command: binaryPath,
    args: [
      'acp',
      ...(resumeSessionId && (await savedConversation(env, resumeSessionId))
        ? ['--resume', resumeSessionId]
        : []),
    ],
    env: { ...env, OPENHANDS_SUPPRESS_BANNER: '1' },
  }),
  loginCommand: OPENHANDS_LOGIN,
  inheritEnv: ['OPENHANDS_PERSISTENCE_DIR'],
  unsupportedPlatforms: {
    win32: 'The OpenHands CLI does not run on Windows itself, only inside WSL.',
  },
  // A session runs the model in the CLI's settings, so that is what is
  // checked. Its only `authenticate` method is OpenHands Cloud's device
  // sign-in, listed whether or not a model is set up, and never sent.
  checkSignIn: async ({ env }) => {
    const model = await openhandsModel(env);
    return model
      ? readiness('authenticated', `Signed in. Sessions run ${model}, the model set in OpenHands.`)
      : readiness('unauthenticated', SIGNED_OUT);
  },
  // OpenHands 1.16 passes an HTTP server's headers on as a list where its MCP
  // client takes a map, and fails every prompt of the session.
  httpMcpOverStdio: true,
  // OpenHands' SDK makes a pydantic model of each MCP tool on a base with a
  // computed `kind`, and an argument of that name fails every tool.
  renamedToolArguments: ['kind'],
  resumeOnLaunch: true,
  // It accepts `session/set_model` and runs the model in its settings anyway.
  fixedModel: openhandsModel,
  interruptPermissionWithError: true,
  // Its ACP server reads its input with asyncio's default 64 KiB line limit,
  // and stops reading for good at a longer line. Switch's context alone is
  // longer, so the first prompt of a session goes in parts.
  maxLineBytes: 64 * 1024,
  // Its modes are confirmation policies. In auto mode its own security
  // analyzer settles every action it rates below high risk.
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
  itemType: (toolCall) => (toolCall.rawInput?.kind === 'TaskAction' ? 'subagent' : undefined),
  // An MCP tool call names its arguments but not its tool or server, so it
  // is put on a server only when OpenHands has just one: the session's, and
  // none of its own in mcp.json.
  mcpServerOf: (toolCall, servers) =>
    toolCall.rawInput?.kind === 'MCPToolAction' && servers.size === 1 ? [...servers][0] : undefined,
  ownMcpServers: openhandsMcpServers,
  // Before each step it asks one "Confirm Agent Actions" for all the step's
  // actions, each announced as a tool call just before.
  confirmsAnnouncedToolCalls: (request) =>
    request.toolCall.toolCallId === `confirmation-${request.sessionId}`,
};

export function createOpenhandsAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(openhandsAcp, options);
}
