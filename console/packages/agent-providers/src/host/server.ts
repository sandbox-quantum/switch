import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, rename, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { commandSchema } from '@switch-console/shared/session-v1';
import type { Command, Session } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import type { ProviderAdapter, ProviderSessionStartInput } from '../adapter';
import { createClaudeAdapter } from '../claude/claude-adapter';
import { createCodexAdapter } from '../codex/codex-adapter';
import { createCursorAdapter } from '../cursor/cursor-adapter';
import { createGeminiAdapter } from '../gemini/gemini-adapter';
import { createOpencodeAdapter } from '../opencode/opencode-adapter';
import { HostedSession } from './session-host';

const id = z.string().min(1).max(200);
const env = z.record(z.string(), z.string());
const mcp = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()),
    env: env.optional(),
  }),
  z.object({ transport: z.literal('http'), url: z.string(), headers: env.optional() }),
]);
const startSchema = z.strictObject({
  provider: z.enum(['claude', 'codex', 'opencode', 'gemini', 'cursor']),
  input: z.strictObject({
    sessionId: id,
    cwd: z.string().min(1),
    runtimeMode: z.enum(['approval-required', 'auto-accept-edits', 'full-access']),
    env,
    mcpServers: z.record(z.string(), mcp),
    model: z.object({ id: z.string(), options: env.optional() }).optional(),
    systemContext: z.string().optional(),
    agentName: z.string().optional(),
    resume: z.object({ nativeSessionId: id }).optional(),
  }),
});
export type HostStartRequest = z.infer<typeof startSchema>;
export interface HostEndpoint {
  url: string;
  token: string;
  pid: number;
}
const folder = (root: string, sessionId: string) =>
  join(root, 'sessions', createHash('sha256').update(sessionId).digest('hex'));

function adapterFor(provider: Session['provider']): ProviderAdapter {
  switch (provider) {
    case 'claude':
      return createClaudeAdapter();
    case 'codex':
      return createCodexAdapter();
    case 'opencode':
      return createOpencodeAdapter();
    case 'gemini':
      return createGeminiAdapter();
    case 'cursor':
      return createCursorAdapter();
  }
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function startHostServer(
  root: string
): Promise<{ endpoint: HostEndpoint; close(): Promise<void> }> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const ownerPath = join(root, 'owner.lock');
  // The launcher must fence a dead owner before removing a stale lock.
  await writeFile(ownerPath, String(process.pid), { flag: 'wx', mode: 0o600 });
  let closing = false;
  const token = randomUUID();
  const sessions = new Map<string, HostedSession>();
  const starts = new Map<string, Promise<HostedSession>>();
  const errors = new Map<string, string>();
  const start = (input: HostStartRequest): Promise<HostedSession> => {
    if (closing) return Promise.reject(new Error('SDK host is shutting down.'));
    const existing = starts.get(input.input.sessionId);
    if (existing) return existing;
    const operation = (async () => {
      if (input.input.env.SWITCH_AGENT_ID || input.input.env.SWITCH_API_TOKEN)
        throw new Error(
          'Shared Switch sessions require the server lease and command transport; local bypass is not permitted.'
        );
      const adapter = adapterFor(input.provider);
      const path = folder(root, input.input.sessionId);
      await mkdir(path, { recursive: true, mode: 0o700 });
      await writeFile(join(path, 'config.json'), JSON.stringify(input), { mode: 0o600 });
      const session: Session = {
        sessionId: input.input.sessionId,
        agentId: input.input.sessionId,
        hostId: 'local-sdk-host',
        epoch: randomUUID(),
        provider: input.provider,
        status: 'starting',
        connectivity: 'online',
        pendingRequestIds: [],
        capabilities: {
          input: 'queue',
          approvals: adapter.capabilities.approvals,
          questions: adapter.capabilities.userInput,
          interrupt: true,
          reset: false,
          compact: false,
          modelChange: false,
          attachmentMimeTypes: [],
        },
      };
      const hosted = await HostedSession.start(
        path,
        { session, input: input.input as ProviderSessionStartInput },
        adapter
      );
      sessions.set(session.sessionId, hosted);
      return hosted;
    })();
    starts.set(input.input.sessionId, operation);
    void operation.catch((error: unknown) => {
      errors.set(input.input.sessionId, String(error));
    });
    return operation;
  };
  const server = createServer((request, response) => {
    void (async () => {
      const authorization = request.headers.authorization ?? '';
      const expected = `Bearer ${token}`;
      if (
        Buffer.byteLength(authorization) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))
      ) {
        response.writeHead(401).end();
        return;
      }
      const url = new URL(request.url ?? '/', 'http://localhost');
      let result: unknown;
      if (request.method === 'GET' && url.pathname === '/health') result = { ready: true };
      else if (request.method === 'GET' && url.pathname === '/sessions')
        result = {
          sessions: [...sessions.values()].map((s) => s.snapshot().session),
          errors: [...errors].map(([sessionId, error]) => ({ sessionId, error })),
        };
      else if (request.method === 'POST' && url.pathname === '/sessions') {
        const input = startSchema.parse(await body(request));
        if (starts.has(input.input.sessionId)) {
          response.writeHead(409).end('Session already exists.');
          return;
        }
        result = (await start(input)).snapshot();
      } else {
        const parts = url.pathname.split('/').filter(Boolean);
        const session = sessions.get(decodeURIComponent(parts[1] ?? ''));
        if (parts[0] !== 'sessions' || !session) {
          response.writeHead(404).end('Session not found.');
          return;
        }
        if (request.method === 'GET' && parts[2] === 'snapshot') result = session.snapshot();
        else if (request.method === 'GET' && parts[2] === 'events') {
          const after = Number(url.searchParams.get('after') ?? 0);
          if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid cursor.');
          result = session.replay(after);
        } else if (request.method === 'GET' && parts[2] === 'commands' && parts[3])
          result = session.status(decodeURIComponent(parts[3]));
        else if (request.method === 'POST' && parts[2] === 'commands') {
          const input = await body(request);
          if (!input || typeof input !== 'object' || 'origin' in input)
            throw new Error('Client-supplied origin is not permitted.');
          const command = commandSchema.parse({
            ...input,
            origin: {
              actorId: 'local-console-user',
              surface: 'console',
              roomId: null,
              threadId: null,
              messageId: null,
            },
          });
          if (command.sessionId !== session.config.session.sessionId)
            throw new Error('Session identity mismatch.');
          if (
            command.body.type === 'message.send' &&
            command.body.audience.kind !== 'session-members'
          )
            throw new Error('Local-only session cannot publish to rooms.');
          result = await session.command(command as Command);
        } else {
          response.writeHead(404).end();
          return;
        }
      }
      response
        .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify(result));
    })().catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  }).catch(async (error: unknown) => {
    await unlink(ownerPath);
    throw error;
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Host listen failed.');
  const endpoint: HostEndpoint = {
    url: `http://127.0.0.1:${address.port}`,
    token,
    pid: process.pid,
  };
  const temp = join(root, 'endpoint.tmp');
  await writeFile(temp, JSON.stringify(endpoint), { mode: 0o600 });
  await rename(temp, join(root, 'endpoint.json'));
  const directories = await readdir(join(root, 'sessions'), { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  );
  for (const directory of directories)
    if (directory.isDirectory()) {
      try {
        const input = startSchema.parse(
          JSON.parse(await readFile(join(root, 'sessions', directory.name, 'config.json'), 'utf8'))
        );
        void start(input).catch(() => {});
      } catch (error) {
        errors.set(directory.name, `Cannot recover session: ${String(error)}`);
      }
    }
  return {
    endpoint,
    async close() {
      closing = true;
      await Promise.allSettled(starts.values());
      const results = await Promise.allSettled([...sessions.values()].map((s) => s.shutdown()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      await unlink(ownerPath);
      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length)
        throw new AggregateError(
          failures.map((r) => r.reason),
          'Provider shutdown failed.'
        );
    },
  };
}
