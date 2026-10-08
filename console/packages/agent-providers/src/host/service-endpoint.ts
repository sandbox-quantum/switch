import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { z } from 'zod';
import type { Redactions } from './redaction';
import { serviceTokenAnswerSchema } from './service-access';
import { serviceFallbackNotice, type ServiceNotices } from './service-notices';
import type { HostAsk } from './session-channel';

/** How long a helper waits for its token: Switch may be refreshing the owner's sign-in. */
const ASK_TIMEOUT_MS = 90_000;
const MAX_BODY_BYTES = 32 * 1024;
const PATH = /^\/services\/([a-z0-9][a-z0-9-]{0,62})\/token$/;

/** The session's endpoint as its helpers find it, in `SWITCH_SERVICE_ENDPOINT` and `SWITCH_SERVICE_BEARER`. */
export type ServiceEndpointServer = { url: string; token: string; close: () => Promise<void> };

/**
 * Where the helpers a session's CLI starts (Git's credential helper, the `gh`
 * wrapper) get the agent's service tokens: on loopback, behind a bearer
 * minted for this run, serving only the services granted when the session
 * started. Each ask goes up the pipe to the agent host, which holds the
 * tokens. A refusal that ends the service's use (the grant gone, the
 * connection changed) is final for the rest of this session: the helper is
 * told Switch's reason, then and every time after.
 *
 * With `unavailable`, why the grants could not be read as the session
 * started, every request is refused with that reason.
 *
 * A refusal is not the end of it: the helper then answers nothing and Git (or
 * `gh`) uses the machine's own sign-in, if it has one. Every refusal is
 * raised in `notices`, so that is said in the session rather than silent.
 */
export async function startServiceEndpoint(input: {
  services: string[];
  unavailable: string | null;
  ask: (ask: HostAsk) => Promise<unknown>;
  redactions: Redactions;
  notices: ServiceNotices;
}): Promise<ServiceEndpointServer> {
  const secret = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${secret}`);
  const ended = new Map<string, string>();

  const token = async (
    service: string,
    rejected: string | null
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    if (input.unavailable !== null)
      return {
        status: 403,
        body: {
          error: `Switch could not load this agent's grants when this session started (${input.unavailable}), so it hands out no ${service} token in this session. A new session loads them again.`,
        },
      };
    if (!input.services.includes(service))
      return {
        status: 404,
        body: {
          error: `This agent had no ${service} grant when this session started. A grant made since reaches the session when it next starts.`,
        },
      };
    const reason = ended.get(service);
    if (reason !== undefined) return { status: 403, body: { error: reason } };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let raw: unknown;
    try {
      raw = await Promise.race([
        input.ask({ type: 'service-token', service, rejected }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error(`The agent host did not answer for a ${service} token in time.`)),
            ASK_TIMEOUT_MS
          );
        }),
      ]);
    } catch (error) {
      return {
        status: 503,
        body: { error: error instanceof Error ? error.message : String(error) },
      };
    } finally {
      clearTimeout(timer);
    }
    const answer = serviceTokenAnswerSchema.parse(raw);
    if (answer.kind === 'token') {
      input.redactions.add(answer.token);
      return { status: 200, body: { token: answer.token, expires_at: answer.expiresAt } };
    }
    if (answer.final) {
      ended.set(service, answer.message);
      return { status: 403, body: { error: answer.message } };
    }
    return { status: 503, body: { error: answer.message } };
  };

  const server = http.createServer((req, res) => {
    const reply = (status: number, body: Record<string, unknown>) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const presented = Buffer.from(req.headers.authorization ?? '');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      reply(401, { error: 'unauthorized' });
      return;
    }
    const match = PATH.exec(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    if (!match) {
      reply(404, { error: 'not found' });
      return;
    }
    if (req.method !== 'POST') {
      reply(405, { error: 'method not allowed' });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reply(413, { error: 'request too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.headersSent) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString() || '{"rejected":null}');
      } catch {
        reply(400, { error: 'invalid request' });
        return;
      }
      const parsed = z.object({ rejected: z.string().nullable() }).safeParse(body);
      if (!parsed.success) {
        reply(400, { error: 'invalid request' });
        return;
      }
      const service = match[1]!;
      token(service, parsed.data.rejected).then(
        ({ status, body }) => {
          // The helper falls back to the machine's own sign-in; say so.
          if (status !== 200)
            input.notices.raise(serviceFallbackNotice(service, String(body.error)));
          reply(status, body);
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          input.notices.raise(serviceFallbackNotice(service, message));
          reply(500, { error: message });
        }
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('The service endpoint has no port.');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    token: secret,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
