import { z } from 'zod';
import type { SignInCheckInput } from '../readiness';
import { noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';

export class CodexAppServerTimeout extends Error {}

export async function withCodexAppServer<T>(
  input: SignInCheckInput & { signal?: AbortSignal },
  args: string[],
  deadline: number,
  read: (client: StdioJsonRpcClient, codexHome: string | null) => Promise<T>
): Promise<T> {
  input.signal?.throwIfAborted();
  const client = new StdioJsonRpcClient({
    command: input.binaryPath,
    args: ['app-server', ...args],
    cwd: input.cwd,
    env: input.env,
    logger: noopLogger,
    onExit: () => {},
  });
  let cleanup: Promise<void> | undefined;
  const stop = () => {
    cleanup ??= client.dispose().catch(() => console.warn('Codex app server cleanup failed.'));
    return cleanup;
  };
  const abort = () => void stop();
  input.signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      void stop();
    },
    Math.max(0, deadline - Date.now())
  );
  try {
    const { codexHome } = z.object({ codexHome: z.string().nullish() }).parse(
      await client.request('initialize', {
        clientInfo: { name: 'switch-console', version: '0.1.0' },
      })
    );
    input.signal?.throwIfAborted();
    if (timedOut) throw new CodexAppServerTimeout();
    client.notify('initialized', null);
    const result = await read(client, codexHome ?? null);
    input.signal?.throwIfAborted();
    if (timedOut) throw new CodexAppServerTimeout();
    return result;
  } catch (error) {
    input.signal?.throwIfAborted();
    if (timedOut) throw new CodexAppServerTimeout();
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', abort);
    await stop();
  }
}
