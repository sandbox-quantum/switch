import { z } from 'zod';
import { readiness, signInWith, type ProviderReadiness, type SignInCheckInput } from '../readiness';
import { noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';

export const CODEX_LOGIN = 'codex login';

export async function checkCodexSignIn(input: SignInCheckInput): Promise<ProviderReadiness> {
  const client = new StdioJsonRpcClient({
    command: input.binaryPath,
    args: ['app-server'],
    cwd: input.cwd,
    env: input.env,
    logger: noopLogger,
    onExit: () => {},
  });
  const timer = setTimeout(() => {
    void client.dispose().catch(() => console.warn('Provider readiness process cleanup failed.'));
  }, 20000);
  try {
    await client.request('initialize', {
      clientInfo: { name: 'switch-console', version: '0.1.0' },
    });
    client.notify('initialized', null);
    const account = z
      .object({ account: z.unknown().nullable(), requiresOpenaiAuth: z.boolean() })
      .parse(await client.request('account/read', { refreshToken: false }));
    if (!account.account && account.requiresOpenaiAuth)
      return readiness('unauthenticated', signInWith(CODEX_LOGIN));
    return account.account
      ? readiness('authenticated', 'Signed in.')
      : readiness('unknown', 'This Codex backend does not require OpenAI sign-in.');
  } finally {
    clearTimeout(timer);
    await client.dispose();
  }
}
