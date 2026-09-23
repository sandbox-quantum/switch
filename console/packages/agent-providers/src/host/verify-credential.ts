import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ProviderAdapter, ProviderSessionStartInput } from '../adapter';
import { materializeHostedProvider } from './hosted-provider';
import { checkProviderReadiness } from './provider-readiness';
import { adapterFor } from './server';

const inputSchema = z.object({
  provider: z.enum(['claude', 'codex', 'cursor', 'opencode', 'antigravity']),
  kind: z.enum(['api-key', 'setup-token', 'auth-json']),
  credential: z.string().min(1).max(16384),
  binaryPath: z.string().startsWith('/opt/switch/'),
  home: z.literal('/run/switch-verification'),
});

export async function verifyModelTurn(
  adapter: ProviderAdapter,
  input: ProviderSessionStartInput
): Promise<void> {
  const turnId = randomUUID();
  const marker = 'SWITCH_CONNECTION_OK';
  let text = '';
  let resolveResult: () => void;
  let rejectResult: (error: Error) => void;
  const result = new Promise<void>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // The session may fail before sendTurn returns; keep the rejection observed.
  void result.catch(() => {});
  const timeout = setTimeout(() => rejectResult(new Error('Connection check timed out.')), 90000);
  const unsubscribe = adapter.subscribe((event) => {
    if (event.sessionId !== input.sessionId) return;
    if (
      event.type === 'request.opened' ||
      event.type === 'user-input.requested' ||
      event.type === 'session.exited'
    ) {
      rejectResult(new Error('Connection check could not complete.'));
    }
    if (event.turnId !== turnId) return;
    if (event.type === 'content.delta') text += event.delta;
    if (event.type === 'item.completed' && event.item.type === 'assistant_message' && !text)
      text = event.item.text ?? '';
    if (event.type === 'turn.completed') {
      if (event.outcome === 'completed' && text.includes(marker)) resolveResult();
      else rejectResult(new Error('The provider did not complete the connection check.'));
    }
  });
  try {
    await Promise.race([
      adapter.startSession(input).then(async () => {
        await adapter.sendTurn({
          sessionId: input.sessionId,
          turnId,
          text: `Reply with exactly ${marker}. Do not use tools, read files or run commands.`,
        });
        await result;
      }),
      result,
    ]);
  } finally {
    clearTimeout(timeout);
    unsubscribe();
    await adapter.stopAll();
  }
}

export async function runCredentialVerification(): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 20000) throw new Error('Verification input too large.');
      chunks.push(chunk);
    }
    const input = inputSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const env: Record<string, string> = {
      HOME: input.home,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
    };
    await materializeHostedProvider(input.home, env, {
      status: 'connected',
      provider: input.provider,
      kind: input.kind,
      credential: input.credential,
      revision: randomUUID(),
      sessions: [],
    });
    const cwd = join(input.home, 'workspace');
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    let model: { id: string } | undefined;
    if (input.provider === 'opencode') {
      const providers = Object.keys(JSON.parse(input.credential));
      const readiness = await checkProviderReadiness({
        provider: input.provider,
        binaryPath: input.binaryPath,
        cwd,
        env,
      });
      const candidate = readiness.models.find((entry) =>
        providers.some((provider) => entry.id.startsWith(provider + '/'))
      );
      if (!candidate) throw new Error('No model is available for the configured provider.');
      model = { id: candidate.id };
    }
    await verifyModelTurn(adapterFor(input.provider, input.binaryPath), {
      sessionId: randomUUID(),
      cwd,
      runtimeMode: 'approval-required',
      env,
      mcpServers: {},
      model,
    });
    let credential = input.credential;
    if (input.kind === 'auth-json') {
      const authPath =
        input.provider === 'codex'
          ? join(env.CODEX_HOME, 'auth.json')
          : input.provider === 'opencode'
            ? join(env.XDG_DATA_HOME, 'opencode/auth.json')
            : join(env.GEMINI_HOME, 'antigravity-acp/acp_token.json');
      credential = await readFile(authPath, 'utf8');
    }
    process.stdout.write(JSON.stringify({ succeeded: true, credential }) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({ succeeded: false }) + '\n');
  }
}
