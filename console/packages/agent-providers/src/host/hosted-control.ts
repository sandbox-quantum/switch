import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { fetchHostedProvider } from './hosted-provider';
import {
  ensureSharedProcess,
  sharedSessionRoot,
  sharedSessionsBase,
  liveSupervisor,
  type Supervision,
} from './launch';
import { HostedSession } from './session-host';
import { readSharedCredentials, sharedConfigSchema, type SharedHostConfig } from './shared-config';

const operationSchema = z.object({
  id: z.string().uuid(),
  session_id: z.string().uuid(),
  action: z.enum(['start', 'restart']),
});

export async function hostedRequest(
  config: SharedHostConfig,
  path: string,
  body: unknown
): Promise<unknown> {
  const credentials = await readSharedCredentials(config);
  const endpoint = new URL(credentials.SWITCH_API_ENDPOINT);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('Cloud control requires an HTTPS server origin.');
  const response = await fetch(`${endpoint.href.replace(/\/$/, '')}/hosted${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credentials.SWITCH_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Cloud control request failed (HTTP ${response.status}).`);
  }
  return response.json();
}

export async function executeHostedOperation(
  template: SharedHostConfig,
  operation: z.infer<typeof operationSchema>,
  supervision: Supervision
): Promise<void> {
  const root = sharedSessionRoot(operation.session_id);
  let config: SharedHostConfig;
  if (operation.action === 'restart') {
    config = sharedConfigSchema.parse(
      JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
    );
    if (
      config.session.agentId !== template.session.agentId ||
      config.session.sessionId !== operation.session_id
    )
      throw new Error('The saved cloud session belongs to another agent.');
  } else {
    config = structuredClone(template);
    config.session.sessionId = operation.session_id;
    config.session.hostId = randomUUID();
    config.session.epoch = randomUUID();
    config.start.input.sessionId = operation.session_id;
    config.start.input.resume = undefined;
    config.roomConnection = { connectionId: randomUUID(), rooms: [], startCursor: 0 };
  }
  await ensureSharedProcess({
    root,
    config,
    resuming: operation.action === 'restart',
    watcher: false,
    restart: operation.action === 'restart',
    supervision,
  });
}

export async function runHostedControl(
  template: SharedHostConfig,
  signal: AbortSignal,
  supervision: Supervision
): Promise<void> {
  const applied = new Map<string, string>();
  const recovered = new Set<string>();
  const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
  const initial = fingerprint(
    process.env.ANTHROPIC_API_KEY ??
      process.env.CLAUDE_CODE_OAUTH_TOKEN ??
      process.env.OPENAI_API_KEY ??
      process.env.CURSOR_API_KEY ??
      process.env.SWITCH_HOSTED_AUTH_JSON ??
      ''
  );
  while (!signal.aborted) {
    try {
      const credential = await fetchHostedProvider(template);
      const current = credential.status === 'connected' ? fingerprint(credential.credential) : null;
      let names: string[] = [];
      try {
        names = await readdir(sharedSessionsBase());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      for (const name of names) {
        const root = join(sharedSessionsBase(), name);
        let saved: SharedHostConfig;
        try {
          saved = sharedConfigSchema.parse(
            JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
          );
        } catch (error) {
          if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
          throw error;
        }
        if (
          saved.session.agentId !== template.session.agentId ||
          (await HostedSession.isStopped(root))
        )
          continue;
        const sessionId = saved.session.sessionId;
        const live = await liveSupervisor(root);
        if (!live) {
          if (
            credential.status === 'connected' &&
            !recovered.has(sessionId) &&
            credential.sessions.some(
              (session) => session.id === sessionId && ['ready', 'running'].includes(session.status)
            )
          ) {
            recovered.add(sessionId);
            await ensureSharedProcess({
              root,
              config: saved,
              resuming: true,
              watcher: false,
              restart: false,
              supervision,
            });
          }
          continue;
        }
        if (credential.status === 'revoked') {
          await supervision.stop(root);
          applied.delete(sessionId);
          console.warn(
            'Cloud provider disconnected; session execution stopped. Reconnect the provider before resuming.'
          );
        } else if (
          (applied.get(sessionId) ?? initial) !== current &&
          credential.sessions.some(
            (session) => session.id === sessionId && session.status === 'ready'
          )
        ) {
          await executeHostedOperation(
            template,
            { id: randomUUID(), session_id: sessionId, action: 'restart' },
            supervision
          );
          applied.set(sessionId, current!);
        }
      }
      const value = await hostedRequest(template, '/operations/claim', {});
      if (value !== null) {
        const operation = operationSchema.parse(value);
        let result: { state: 'applied' | 'unknown'; error: string | null };
        try {
          await executeHostedOperation(template, operation, supervision);
          result = { state: 'applied', error: null };
        } catch {
          result = {
            state: 'unknown',
            error:
              'The worker could not confirm session startup. Inspect its transcript before retrying.',
          };
        }
        // A lost result is never a reason to execute the operation again.
        await hostedRequest(template, `/operations/${operation.id}/result`, result);
      }
    } catch (error) {
      if (!signal.aborted)
        console.error(error instanceof Error ? error.message : 'Cloud control failed.');
    }
    await delay(2000, undefined, { signal }).catch((error: unknown) => {
      if (!signal.aborted) throw error;
    });
  }
}
