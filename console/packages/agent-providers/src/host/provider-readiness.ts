import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { createAntigravityClient, initializeAntigravity } from '../antigravity/runtime';
import { startOpencodeServer, stopOpencodeServer } from '../opencode/server';
import { JsonRpcError, noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';

export const providerReadinessSchema = z.object({
  status: z.enum(['authenticated', 'unauthenticated', 'unknown']),
  message: z.string(),
  models: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type ProviderReadiness = z.infer<typeof providerReadinessSchema>;
const execute = promisify(execFile);
const login: Record<string, string> = {
  claude: 'claude auth login',
  codex: 'codex login',
  cursor: 'agent login',
  antigravity: 'antigravity-acp --login',
  opencode: 'opencode auth login',
};
function result(status: ProviderReadiness['status'], message: string): ProviderReadiness {
  return { status, message, models: [] };
}
export function parseAuthentication(provider: string, output: string): ProviderReadiness {
  if (provider === 'claude') {
    const value = z.object({ loggedIn: z.boolean() }).safeParse(JSON.parse(output));
    if (value.success)
      return result(
        value.data.loggedIn ? 'authenticated' : 'unauthenticated',
        value.data.loggedIn
          ? 'Signed in.'
          : `Sign in on the execution machine with ${login[provider]}.`
      );
  }
  if (provider === 'cursor') {
    const email = output.match(/User Email(?:[ \t]*:[ \t]*|[ \t]+)(.+)/i)?.[1]?.trim();
    if (email)
      return result(
        /not logged in|login required|authentication required/i.test(email)
          ? 'unauthenticated'
          : 'authenticated',
        /not logged in|login required|authentication required/i.test(email)
          ? 'Sign in on the execution machine with agent login.'
          : 'Signed in.'
      );
  }
  return result('unknown', 'Could not verify authentication. Check provider setup and try again.');
}
export async function checkProviderReadiness(input: {
  provider: string;
  binaryPath: string;
  cwd: string;
  env: Record<string, string>;
}): Promise<ProviderReadiness> {
  let client: StdioJsonRpcClient | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (input.provider === 'opencode') {
      const server = await startOpencodeServer({
        ...input,
        startupTimeoutMs: 15000,
        skills: [],
        config: { $schema: 'https://opencode.ai/config.json', permission: {}, mcp: {} },
      });
      try {
        const response = await fetch(`${server.url}/provider`, {
          headers: { Authorization: server.authorization },
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) return result('unknown', 'Could not check OpenCode backend connections.');
        const inventory = z.object({ connected: z.array(z.string()) }).parse(await response.json());
        return result(
          inventory.connected.length ? 'authenticated' : 'unknown',
          inventory.connected.length
            ? 'OpenCode has connected backends. Model access depends on the selected backend.'
            : 'No connected OpenCode backends were reported. Configure a backend; local models may need no sign-in.'
        );
      } finally {
        await stopOpencodeServer(server);
      }
    }
    if (input.provider === 'claude' || input.provider === 'cursor') {
      let output: string;
      try {
        output = (
          await execute(
            input.binaryPath,
            input.provider === 'claude' ? ['auth', 'status'] : ['about'],
            { cwd: input.cwd, env: input.env, timeout: 15000, maxBuffer: 1024 * 1024 }
          )
        ).stdout;
      } catch (error) {
        // A signed-out CLI may return a nonzero exit with a structured status.
        output =
          typeof (error as { stdout?: unknown }).stdout === 'string'
            ? (error as { stdout: string }).stdout
            : '';
      }
      return parseAuthentication(input.provider, output);
    }
    if (input.provider === 'antigravity') {
      client = await createAntigravityClient({ ...input, logger: noopLogger, onExit: () => {} });
      await initializeAntigravity(client);
      return result('authenticated', 'Signed in to Antigravity ACP.');
    }
    if (input.provider !== 'codex')
      return result('unknown', 'This provider has no authentication check.');
    client = new StdioJsonRpcClient({
      command: input.binaryPath,
      args: ['app-server'],
      cwd: input.cwd,
      env: input.env,
      logger: noopLogger,
      onExit: () => {},
    });
    timer = setTimeout(() => {
      void client
        ?.dispose()
        .catch(() => console.warn('Provider readiness process cleanup failed.'));
    }, 20000);
    await client.request('initialize', {
      clientInfo: { name: 'switch-console', version: '0.1.0' },
    });
    client.notify('initialized', null);
    const account = z
      .object({ account: z.unknown().nullable(), requiresOpenaiAuth: z.boolean() })
      .parse(await client.request('account/read', { refreshToken: false }));
    if (!account.account && account.requiresOpenaiAuth)
      return result('unauthenticated', 'Sign in on the execution machine with codex login.');
    return result(
      account.account ? 'authenticated' : 'unknown',
      account.account ? 'Signed in.' : 'This Codex backend does not require OpenAI sign-in.'
    );
  } catch (error) {
    if (
      input.provider === 'antigravity' &&
      /sign in|auth required|unauthenticated/i.test(String(error))
    )
      return result(
        'unauthenticated',
        'Sign in on the execution host with antigravity-acp --login.'
      );
    if (
      error instanceof JsonRpcError &&
      error.code === -32000 &&
      /auth|log.?in|sign.?in|API key is missing|no API key/i.test(error.message)
    )
      return result(
        'unauthenticated',
        `Sign in on the execution machine with ${login[input.provider]}.`
      );
    return result(
      'unknown',
      'Could not verify authentication. Check the connection and provider setup, then retry.'
    );
  } finally {
    if (timer) clearTimeout(timer);
    await client?.dispose();
  }
}
