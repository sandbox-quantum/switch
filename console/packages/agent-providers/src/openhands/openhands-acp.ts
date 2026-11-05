import { readFileSync } from 'node:fs';
import { access, open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { loginWontHelp, readiness, type ProviderReadiness } from '../readiness';

export const OPENHANDS_LOGIN = 'openhands';
const SET_UP = `On the execution machine, run ${OPENHANDS_LOGIN} and choose its LLM in /settings.`;
const UV_INSTALL = 'uv tool install openhands --python 3.12';

/** Where OpenHands keeps its settings and conversations. */
export function openhandsHome(env: Record<string, string | undefined>): string {
  return env.OPENHANDS_PERSISTENCE_DIR?.trim() || join(env.HOME?.trim() || homedir(), '.openhands');
}

/**
 * The model OpenHands' saved settings name: null when there are no settings,
 * or they name no model. A file that is there but cannot be read throws.
 */
export async function openhandsSettingsModel(env: Record<string, string>): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(join(openhandsHome(env), 'agent_settings.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let model: unknown;
  try {
    model = (JSON.parse(text) as { llm?: { model?: unknown } }).llm?.model;
  } catch {
    return null;
  }
  return typeof model === 'string' && model ? model : null;
}

/**
 * Runs `openhands acp` with its ACP reader's line limit raised. 1.16 opens
 * stdio with Python's 64 KiB default rather than the ACP library's 50 MB, and
 * a session's first prompt carries the Switch skill, which is longer: the line
 * kills its reader and the prompt is never answered.
 *
 * It also lets a turn end on a reply with no text. OpenHands answers one by
 * telling the model it forgot a tool call, and in a room, where the agent has
 * already posted with `post_message` and its final text is shown to nobody,
 * the model posts the same reply again. The turn now finishes there, as a
 * reply with text does. Arguments after the script go to `openhands acp`.
 */
export const OPENHANDS_ACP_SHIM = [
  'import sys',
  'import acp',
  'import openhands_cli.acp_impl.agent.launcher as launcher',
  'from openhands.sdk.agent import response_dispatch',
  'from openhands.sdk.conversation.state import ConversationExecutionStatus',
  'from openhands_cli.entrypoint import main',
  "if not callable(getattr(launcher, 'stdio_streams', None)):",
  "    sys.exit('Switch cannot raise the ACP line limit of this OpenHands CLI: its launcher no longer opens stdio with stdio_streams.')",
  "if not callable(getattr(getattr(response_dispatch, 'ResponseDispatchMixin', None), '_handle_no_content_response', None)):",
  "    sys.exit('Switch cannot end a turn on a reply with no text in this OpenHands CLI: ResponseDispatchMixin no longer has _handle_no_content_response.')",
  'opened = acp.stdio_streams',
  'async def stdio_streams(limit=None, **kwargs):',
  '    return await opened(limit=limit or 50 * 1024 * 1024, **kwargs)',
  'launcher.stdio_streams = stdio_streams',
  'def finish(self, message, llm_response, conversation, state, on_event, *, response_type):',
  '    self._emit_message_event(message, llm_response, conversation, on_event)',
  '    self._maybe_emit_vllm_tokens(llm_response, on_event)',
  '    state.execution_status = ConversationExecutionStatus.FINISHED',
  'response_dispatch.ResponseDispatchMixin._handle_no_content_response = finish',
  "sys.argv = ['openhands', 'acp', *sys.argv[1:]]",
  'sys.exit(main())',
].join('\n');

/**
 * The Python an `openhands` install runs on, from its script's first line,
 * looked up on `path` when `binaryPath` is a bare name. The single-file
 * binary has none.
 */
export async function openhandsPython(
  binaryPath: string,
  path: string | undefined
): Promise<string | null> {
  const candidates = isAbsolute(binaryPath)
    ? [binaryPath]
    : (path ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, binaryPath));
  for (const candidate of candidates) {
    let head: string;
    try {
      const file = await open(candidate, 'r');
      try {
        const buffer = Buffer.alloc(512);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        head = buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0] ?? '';
      } finally {
        await file.close();
      }
    } catch {
      continue;
    }
    const interpreter = /^#!\s*(?:\/usr\/bin\/env\s+)?(\S+)/.exec(head)?.[1];
    return interpreter && /(^|\/)python[\d.]*$/.test(interpreter) ? interpreter : null;
  }
  return null;
}

/**
 * Whether OpenHands has MCP servers of its own, in `mcp.json`, that it loads
 * beside a session's. A file it cannot read counts as having some.
 */
export function openhandsHasOwnMcpServers(env: Record<string, string>): boolean {
  let text: string;
  try {
    text = readFileSync(join(openhandsHome(env), 'mcp.json'), 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  try {
    const servers = (JSON.parse(text) as { mcpServers?: Record<string, { enabled?: unknown }> })
      .mcpServers;
    return Object.values(servers ?? {}).some((server) => server?.enabled !== false);
  } catch {
    return true;
  }
}

/**
 * OpenHands counts itself signed in once its LLM is saved in
 * `agent_settings.json`; until then its ACP server refuses to start a session.
 */
export async function checkOpenhandsSettings(
  env: Record<string, string>
): Promise<ProviderReadiness> {
  const model = await openhandsSettingsModel(env);
  return model
    ? readiness('authenticated', `Set up to run ${model}.`)
    : readiness('unauthenticated', `OpenHands has no LLM set up. ${SET_UP}`);
}

/** The OpenHands CLI's `openhands acp`, which runs the LLM in its own settings. */
export const openhandsAcp: AcpProviderHooks = {
  provider: 'openhands',
  label: 'OpenHands',
  defaultBinary: 'openhands',
  capabilities: {
    modelSwitchInSession: false,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  // Isolated (-I), so nothing in the working directory is imported.
  launch: async ({ binaryPath, env, resume }) => {
    const python = await openhandsPython(binaryPath, env.PATH);
    if (!python)
      throw new Error(
        `${binaryPath} is not the Python install of the OpenHands CLI, which Switch needs to run it: its prompts carry instructions longer than the 64 KiB line its single-file build reads. Install it with: ${UV_INSTALL}`
      );
    return {
      command: python,
      args: ['-I', '-c', OPENHANDS_ACP_SHIM, ...(resume ? ['--resume', resume] : [])],
      env: { ...env, OPENHANDS_SUPPRESS_BANNER: '1' },
    };
  },
  loginCommand: OPENHANDS_LOGIN,
  inheritEnv: ['OPENHANDS_PERSISTENCE_DIR'],
  unsupportedPlatforms: {
    win32:
      'The OpenHands CLI does not run on Windows itself; run the agent in WSL or on a Linux host.',
  },
  // Its one auth method signs in to OpenHands Cloud, which a local session
  // does not use: the sign-in it needs is the LLM in its settings.
  checkSignIn: async ({ binaryPath, env }) =>
    (await openhandsPython(binaryPath, env.PATH))
      ? checkOpenhandsSettings(env)
      : loginWontHelp(
          readiness(
            'unconfigured',
            `This OpenHands CLI is its single-file build, which cannot read a Switch session's first prompt. Install it with: ${UV_INSTALL}`
          )
        ),
  // `session/set_model` is a no-op in 1.16, and `acp` never applies
  // `--override-with-envs`, so the model in its settings is the only one a
  // session can run.
  settingsModel: openhandsSettingsModel,
  // Its ACP server passes an HTTP server's headers on as ACP's list, which its
  // MCP configuration refuses, failing every prompt; stdio servers it takes.
  httpMcpOverStdio: true,
  // Its session/load ignores the MCP servers it is sent; `--resume` with
  // session/new applies them. For an id it never saved it would start an
  // empty conversation under that id.
  resumesAtLaunch: async (conversation, env) => {
    try {
      await access(
        join(
          openhandsHome(env),
          'conversations',
          conversation.replaceAll('-', ''),
          'base_state.json'
        )
      );
      return true;
    } catch {
      return false;
    }
  },
  // It asks once for every action it has queued, as "Confirm Agent Actions",
  // and names none of them.
  confirmsOpenToolCalls: (request) => request.toolCall.toolCallId.startsWith('confirmation-'),
  // Its MCP tool calls carry only their arguments, never the server. A call
  // can only be on the session's server when that is the one server it was
  // given and it has none of its own; otherwise it is left unknown and asks.
  mcpServerOf: (toolCall, session) =>
    toolCall.rawInput?.kind === 'MCPToolAction' &&
    session.mcpServers.size === 1 &&
    !openhandsHasOwnMcpServers(session.env)
      ? [...session.mcpServers][0]
      : undefined,
  itemType: (toolCall) =>
    toolCall.rawInput?.kind === 'TaskAction' || toolCall.rawInput?.kind === 'DelegateAction'
      ? 'subagent'
      : undefined,
  // OpenHands' modes are confirmation policies. Its LLM security analyzer is
  // the reviewer auto mode stands for; edits in auto-accept-edits are
  // allowed by the adapter, so that mode asks for the rest.
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

export function createOpenhandsAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(openhandsAcp, options);
}
