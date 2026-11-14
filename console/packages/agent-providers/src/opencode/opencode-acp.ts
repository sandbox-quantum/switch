import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { answerFormElicitations, FORM_ELICITATION_CAPABILITIES } from '../acp/elicitation';
import type { AcpCompactionProgress, AcpProviderHooks } from '../acp/hooks';
import type { AcpSessionUpdate, AcpToolCall } from '../acp/protocol';
import type { ProviderCapabilities } from '../adapter';
import { execProvider } from '../provider-process';
import { readiness, type ProviderReadiness, type SignInCheckInput } from '../readiness';
import { mcpConfigFor, permissionConfigFor, type OpencodeConfigFile } from './config';
import { prepareOpencodeHome } from './home';
import type { OpencodeSkill } from './server';
import { OPENCODE_LOGIN } from './sign-in';

export const OPENCODE_CAPABILITIES: ProviderCapabilities = {
  modelSwitchInSession: true,
  steering: true,
  resume: true,
  approvals: true,
  userInput: true,
};

const SIGN_IN_TIMEOUT_MS = 30000;

/**
 * The `opencode` provider OpenCode builds in for its free models. It is always
 * listed, with the public key, whether or not anything is signed in.
 */
function isFreeModelsOnly(provider: { id: string; settings?: { apiKey?: unknown } }): boolean {
  return provider.id === 'opencode' && provider.settings?.apiKey === 'public';
}

const providerListSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      settings: z.object({ apiKey: z.unknown().optional() }).passthrough().optional(),
    })
  ),
});

/**
 * What OpenCode 2 says about the providers a session here could use, asked of
 * a private server (`--standalone`) so the check neither starts nor talks to
 * the shared background service. Listing providers runs no model call.
 */
export function parseOpencodeProviders(stdout: string): ProviderReadiness {
  const { data } = providerListSchema.parse(JSON.parse(stdout));
  const connected = data.filter((provider) => !isFreeModelsOnly(provider));
  if (connected.length)
    return readiness(
      'authenticated',
      `Connected: ${connected.map((provider) => provider.name ?? provider.id).join(', ')}. Model access depends on the model you pick.`
    );
  return readiness(
    'unconfigured',
    data.length
      ? `No provider is connected, so only OpenCode's free models are available. To use your own account, run ${OPENCODE_LOGIN} on this computer.`
      : `No OpenCode provider is available. Run ${OPENCODE_LOGIN} on this computer.`
  );
}

export async function checkOpencode2SignIn(input: SignInCheckInput): Promise<ProviderReadiness> {
  const { stdout } = await execProvider(
    input.binaryPath,
    ['api', '--standalone', 'provider.list'],
    { cwd: input.cwd, env: input.env, timeout: SIGN_IN_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }
  );
  return parseOpencodeProviders(stdout);
}

/** The registered MCP server a tool call belongs to: OpenCode names its tools `<server>_<tool>`. */
export function opencodeMcpServerOf(
  toolCall: AcpToolCall,
  servers: ReadonlySet<string>
): string | undefined {
  const name = (toolCall as { name?: unknown }).name ?? toolCall.title;
  if (typeof name !== 'string') return undefined;
  let match: string | undefined;
  for (const server of servers)
    if (name.startsWith(`${server}_`) && (!match || server.length > match.length)) match = server;
  return match;
}

/**
 * OpenCode 2, driven through `opencode acp`. Each session gets its own config
 * home, as on 1.x: the person's configuration with Switch's permissions, MCP
 * servers and managed skills merged in. `opencode acp` runs a private server
 * for its process, so nothing here is shared with the person's own OpenCode.
 */
const CompactionMeta = z.object({
  status: z.enum(['started', 'completed', 'failed']),
  error: z.object({ message: z.string() }).optional(),
});

/**
 * OpenCode reports a compaction, asked for or its own, in
 * `session_info_update`'s `_meta["opencode/compaction"]`.
 */
export function opencodeCompactionProgress(
  update: AcpSessionUpdate
): AcpCompactionProgress | undefined {
  if (update.sessionUpdate !== 'session_info_update') return undefined;
  const meta = update._meta?.['opencode/compaction'];
  if (meta === undefined) return undefined;
  const parsed = CompactionMeta.safeParse(meta);
  if (!parsed.success)
    return {
      status: 'failed',
      message: `OpenCode reported a compaction Switch cannot read: ${JSON.stringify(meta)}`,
    };
  const { status, error } = parsed.data;
  return status === 'failed'
    ? { status, message: error?.message ?? 'OpenCode gave no reason.' }
    : { status };
}

export function opencodeAcpHooks(skills: OpencodeSkill[]): AcpProviderHooks {
  return {
    provider: 'opencode',
    label: 'OpenCode',
    defaultBinary: 'opencode',
    capabilities: OPENCODE_CAPABILITIES,
    loginCommand: OPENCODE_LOGIN,
    mcpServersAtLaunch: true,
    launch: async ({ binaryPath, env, runtimeMode, mcpServers }) => {
      const mcp = Object.fromEntries(
        Object.entries(mcpConfigFor(mcpServers ?? {})).map(([name, entry]) => [
          name,
          { ...entry, codemode: false as const },
        ])
      );
      // A registered server's tools are approved by the adapter (connectors'
      // aside), so the file names none of them: they ask, and the adapter
      // answers from `mcpServerOf`.
      const config: OpencodeConfigFile = {
        $schema: 'https://opencode.ai/config.json',
        permission: permissionConfigFor(runtimeMode ?? 'approval-required', []),
        mcp,
      };
      const configHome = await prepareOpencodeHome(config, skills, env);
      return {
        command: binaryPath,
        args: ['acp'],
        env: { ...env, XDG_CONFIG_HOME: configHome },
        cleanup: () => rm(configHome, { recursive: true, force: true }),
      };
    },
    checkSignIn: checkOpencode2SignIn,
    steerMethod: '_session/steering',
    compaction: { prompt: '/compact', progress: opencodeCompactionProgress },
    clientCapabilities: FORM_ELICITATION_CAPABILITIES,
    extensions: answerFormElicitations,
    // "Always allow" saves the permission in OpenCode's own database, where
    // every later session in the directory, and the person's terminal, would
    // inherit it.
    persistentPermissionKinds: ['allow_always'],
    mcpServerOf: opencodeMcpServerOf,
    // Auto mode is OpenCode's `--auto`: every ask is approved, and only what the
    // person's configuration denies stays denied (OpenCode never asks about it).
    permission: (context, request) => {
      if (context.runtimeMode !== 'auto') return undefined;
      const once = request.options.find((option) => option.kind === 'allow_once');
      return once
        ? Promise.resolve({ outcome: { outcome: 'selected', optionId: once.optionId } })
        : undefined;
    },
  };
}
