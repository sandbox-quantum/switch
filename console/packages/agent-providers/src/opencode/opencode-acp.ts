import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { answerFormElicitations, FORM_ELICITATION_CAPABILITIES } from '../acp/elicitation';
import type { AcpCompactionProgress, AcpProviderHooks } from '../acp/hooks';
import type { AcpSessionUpdate, AcpToolCall } from '../acp/protocol';
import { ProviderUnavailableError, type ProviderCapabilities } from '../adapter';
import { spawnProvider } from '../provider-process';
import { readiness, type ProviderReadiness, type SignInCheckInput } from '../readiness';
import { mcpConfigFor, permissionConfigFor, type OpencodeConfigFile } from './config';
import { prepareOpencodeHome } from './home';
import { findFreePort, stopOpencodeProcess, type OpencodeSkill } from './server';
import { OPENCODE_LOGIN } from './sign-in';

export const OPENCODE_CAPABILITIES: ProviderCapabilities = {
  modelSwitchInSession: true,
  steering: true,
  resume: true,
  approvals: true,
  userInput: true,
};

const SERVER_START_TIMEOUT_MS = 20000;

/**
 * How long the check waits for a connected provider. From 2.4 OpenCode lists
 * only the providers loaded so far, and loads them after it starts listening,
 * so an early answer can be empty, or only the free models, for a person who
 * is signed in.
 */
const PROVIDERS_SETTLE_MS = 10000;

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

/** What OpenCode 2 says about the providers a session here could use. Listing providers runs no model call. */
export function parseOpencodeProviders(body: string): ProviderReadiness {
  const { data } = providerListSchema.parse(JSON.parse(body));
  const connected = data.filter((provider) => !isFreeModelsOnly(provider));
  if (connected.length)
    return readiness(
      'authenticated',
      `Connected: ${connected.map((provider) => provider.name ?? provider.id).join(', ')}.`
    );
  return readiness(
    'unconfigured',
    data.length
      ? `Free models only. Run ${OPENCODE_LOGIN} to use your own account.`
      : `No provider connected. Run ${OPENCODE_LOGIN}.`
  );
}

/**
 * Asked of a private `opencode serve`, so the check neither starts nor talks to
 * the shared background service, and asked again until a connected provider
 * has loaded or `PROVIDERS_SETTLE_MS` has passed.
 */
export async function checkOpencode2SignIn(input: SignInCheckInput): Promise<ProviderReadiness> {
  const password = randomBytes(24).toString('base64url');
  const port = await findFreePort();
  const child = spawnProvider(
    input.binaryPath,
    ['serve', '--hostname=127.0.0.1', `--port=${port}`],
    {
      cwd: input.cwd,
      env: { ...input.env, OPENCODE_SERVER_PASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  try {
    await opencode2Listening(child);
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    return await settledProviders(`http://127.0.0.1:${port}/api/provider`, authorization);
  } finally {
    await stopOpencodeProcess(child);
  }
}

function opencode2Listening(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new ProviderUnavailableError(
              'opencode',
              `server did not start within ${SERVER_START_TIMEOUT_MS}ms: ${output.trim()}`
            )
          )
        ),
      SERVER_START_TIMEOUT_MS
    );
    const read = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
      if (/listening on https?:\/\//.test(output)) finish(resolve);
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.on('error', (error) =>
      finish(() =>
        reject(new ProviderUnavailableError('opencode', 'could not spawn', { cause: error }))
      )
    );
    child.on('exit', (code) =>
      finish(() =>
        reject(
          new ProviderUnavailableError(
            'opencode',
            `server exited with code ${code}: ${output.trim()}`
          )
        )
      )
    );
  });
}

async function settledProviders(url: string, authorization: string): Promise<ProviderReadiness> {
  const deadline = Date.now() + PROVIDERS_SETTLE_MS;
  let last: ProviderReadiness | undefined;
  let failure = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: { authorization },
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      if (response.ok) {
        last = parseOpencodeProviders(await response.text());
        if (last.status === 'authenticated') return last;
      } else {
        failure = `the provider list returned HTTP ${response.status}`;
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (last) return last;
  throw new ProviderUnavailableError('opencode', `could not list providers: ${failure}`);
}

/** The registered MCP server a tool call belongs to: OpenCode names its tools `<server>_<tool>`. */
export function opencodeMcpServerOf(
  toolCall: AcpToolCall,
  servers: ReadonlySet<string>
): string | undefined {
  const named = (toolCall as { name?: unknown }).name;
  // Without a name the title is all there is, and for a command or an edit
  // OpenCode titles it with the command or the path, which the model writes.
  // It gives every MCP tool the kind `other`.
  if (named === undefined && toolCall.kind !== undefined && toolCall.kind !== 'other')
    return undefined;
  const name = named ?? toolCall.title;
  if (typeof name !== 'string') return undefined;
  let match: string | undefined;
  for (const server of servers)
    if (name.startsWith(`${server}_`) && (!match || server.length > match.length)) match = server;
  return match;
}

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

/**
 * OpenCode 2, driven through `opencode acp`. Each session gets its own config
 * home, as on 1.x: the person's configuration with Switch's permissions, MCP
 * servers and managed skills merged in. `opencode acp` runs a private server
 * for its process, so nothing here is shared with the person's own OpenCode.
 */
export function opencodeAcpHooks(skills: OpencodeSkill[]): AcpProviderHooks {
  return {
    provider: 'opencode',
    label: 'OpenCode',
    defaultBinary: 'opencode',
    capabilities: OPENCODE_CAPABILITIES,
    loginCommand: OPENCODE_LOGIN,
    mcpServersAtLaunch: true,
    thoughtTokensSeparate: true,
    // OpenCode 1 saved a model's reasoning level as its `variant`.
    modelOptionAliases: { variant: 'effort' },
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
    conversationMissing: (error) =>
      error.code === -32602 && error.message.includes('session not found'),
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
