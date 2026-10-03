import { createConnection } from 'node:net';
import { z } from 'zod';
import { ReasonedError } from './errors';

/**
 * The cloud machine's root supervisor, as its agents controller reaches it:
 * a unix socket (`/run/switch-hosted/supervisor.sock`, root-owned, group
 * `switch-agent`, mode 0660) carrying one JSON request and one JSON answer
 * per connection, each a single line.
 *
 * Requests: `install` (an agent's deployment, then its unit started or
 * stopped as the deployment says), `stop`, `remove`, and `state`. Answers are
 * `{ok: true, ...}` or `{ok: false, error: {code, message}}`. The protocol is
 * documented with the supervisor (`deploy/hosted/worker/README.md`).
 */

const unitSchema = z.object({
  installed: z.boolean(),
  revision: z.number().int().nullable(),
  process_state: z.enum([
    'pending',
    'starting',
    'running',
    'stopping',
    'stopped',
    'restarting',
    'crashed',
    'failed',
  ]),
  restarts: z.number().int().nonnegative(),
  oom_kills: z.number().int().nonnegative(),
  exit: z
    .object({
      code: z.number().int().nullable(),
      signal: z.number().int().nullable(),
      result: z.string().nullable(),
    })
    .nullable(),
});
export type SupervisorUnit = z.infer<typeof unitSchema>;

const answerSchema = z.union([
  z.object({ ok: z.literal(true), unit: unitSchema.optional() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string().min(1), message: z.string() }),
  }),
]);

export type SupervisorRequest =
  | { op: 'install'; agent: Record<string, unknown>; restart: boolean }
  | { op: 'stop'; agent_id: string; wait: boolean }
  | { op: 'remove'; agent_id: string }
  | { op: 'prune'; keep: string[] }
  | { op: 'state'; agent_id: string };

/** The longest one answer may take: a removal runs `git worktree remove`, which the supervisor gives 5 minutes. */
const REMOVE_TIMEOUT_MS = 6 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;
const MAX_ANSWER_BYTES = 64 * 1024;

/** Supervisor codes that say the request itself is wrong; anything else is the machine's. */
const DEFINITION_CODES = new Set(['invalid_request', 'invalid_config']);

export interface Supervisor {
  request(request: SupervisorRequest): Promise<SupervisorUnit | null>;
}

export class SocketSupervisor implements Supervisor {
  constructor(private readonly socketPath: string) {}

  async request(request: SupervisorRequest): Promise<SupervisorUnit | null> {
    const timeoutMs =
      request.op === 'remove' || request.op === 'prune' ? REMOVE_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    const line = await exchange(this.socketPath, `${JSON.stringify(request)}\n`, timeoutMs);
    let parsed: z.infer<typeof answerSchema>;
    try {
      parsed = answerSchema.parse(JSON.parse(line));
    } catch (error) {
      throw new Error(
        `The machine supervisor answered ${request.op} with something that is not its protocol: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!parsed.ok)
      throw new ReasonedError(
        DEFINITION_CODES.has(parsed.error.code) ? 'definition_invalid' : 'internal',
        `The machine supervisor refused ${request.op} (${parsed.error.code}): ${parsed.error.message}`
      );
    return parsed.unit ?? null;
  }
}

function exchange(path: string, body: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let received = '';
    let settled = false;
    const finish = (error: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `The machine supervisor did not answer within ${Math.round(timeoutMs / 1000)} s.`
          )
        ),
      timeoutMs
    );
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(body));
    socket.on('data', (chunk: string) => {
      received += chunk;
      if (received.length > MAX_ANSWER_BYTES)
        return finish(new Error('The machine supervisor answered with too much.'));
      const newline = received.indexOf('\n');
      if (newline !== -1) finish(null, received.slice(0, newline));
    });
    socket.on('end', () =>
      finish(new Error('The machine supervisor closed the socket without answering.'))
    );
    socket.on('error', (error) =>
      finish(new Error(`The machine supervisor cannot be reached at ${path}: ${error.message}`))
    );
  });
}
