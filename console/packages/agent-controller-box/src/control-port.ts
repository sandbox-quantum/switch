import { lstat, readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { ControlClient } from '@switch-console/agent-providers-box';
import { z } from 'zod';

const CONTROL_FILE_LIMIT_BYTES = 4096;
const CONNECT_TIMEOUT_MS = 5_000;

const controlFileSchema = z.strictObject({
  port: z.number().int().min(1024).max(65535),
  token: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
});

/**
 * Ask an agent host in a process of its own to warm `roomId`, over the
 * loopback control port named in its `control.json`. The file is the agent's,
 * so it is read as untrusted: not through a symlink, small, a port and a token.
 */
export async function warmOverControlPort(controlFile: string, roomId: string): Promise<void> {
  await overControlPort(controlFile, (client) => client.warm(roomId));
}

/**
 * Tell an agent host in a process of its own that the memory guard is about
 * to stop it, so it tells its rooms. Resolves to how many rooms it told.
 */
export async function stopForMemoryOverControlPort(controlFile: string): Promise<number> {
  return overControlPort(controlFile, (client) => client.stopForMemory());
}

/** The control port named in `control.json` isn't the spawned host's own. */
export class WrongPortError extends Error {
  constructor() {
    super('The control port is not the agent host’s own.');
    this.name = 'WrongPortError';
  }
}

/**
 * From the launcher on a split box: hands a host the one-time ticket for its next hub
 * hello, with its HMAC under the launch's push key, over its own control port.
 * `ownsPort` is asked first, with the port the file names: unless the spawned
 * host is listening on it, nothing is sent (`WrongPortError`). Resolves to the
 * host's answer, its confirmation HMAC; a ticket can never be read back.
 */
export async function giveHubTicketOverControlPort(
  controlFile: string,
  ticket: string,
  mac: string,
  ownsPort: (port: number) => Promise<boolean>
): Promise<string> {
  return overControlPort(controlFile, (client) => client.giveHubTicket(ticket, mac), ownsPort);
}

/** How long a new host is given to write its own control file and take its ticket. */
export const TICKET_HANDOVER_MS = 10_000;
const TICKET_RETRY_MS = 500;

/**
 * From the launcher on a split box: hands a spawned host its ticket, waiting until
 * `deadlineMs` for the host's own control file. Every attempt asks `ownsPort`
 * first, so the ticket only ever goes to the spawned host's own port: a file
 * naming any other port (a dead host's left on the disk, or another process's)
 * is waited past, never used. Still not the host's port at the deadline:
 * `wrong_port`, and the launcher ends the host. Other
 * failures (no file yet) are retried the same way, then thrown.
 */
export async function pushTicketUntilTaken(input: {
  controlFile: string;
  ticket: string;
  mac: string;
  ownsPort: (port: number) => Promise<boolean>;
  taken: (answer: string) => boolean;
  deadlineMs?: number;
  retryMs?: number;
}): Promise<'taken' | 'wrong_port' | 'not_taken'> {
  const deadline = Date.now() + (input.deadlineMs ?? TICKET_HANDOVER_MS);
  for (;;) {
    try {
      const answer = await giveHubTicketOverControlPort(
        input.controlFile,
        input.ticket,
        input.mac,
        input.ownsPort
      );
      return input.taken(answer) ? 'taken' : 'not_taken';
    } catch (error) {
      if (Date.now() > deadline) {
        if (error instanceof WrongPortError) return 'wrong_port';
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, input.retryMs ?? TICKET_RETRY_MS));
    }
  }
}

async function overControlPort<T>(
  controlFile: string,
  ask: (client: ControlClient) => Promise<T>,
  ownsPort?: (port: number) => Promise<boolean>
): Promise<T> {
  const link = await lstat(controlFile);
  if (!link.isFile()) throw new Error(`${controlFile} is not a regular file.`);
  if (link.size > CONTROL_FILE_LIMIT_BYTES) throw new Error(`${controlFile} is too large.`);
  const { port, token } = controlFileSchema.parse(JSON.parse(await readFile(controlFile, 'utf8')));
  if (ownsPort && !(await ownsPort(port))) throw new WrongPortError();
  const client = new ControlClient(connect({ host: '127.0.0.1', port }), token);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.ready.then(() => ask(client)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('The agent host’s control port did not answer in time.')),
          CONNECT_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    client.close();
  }
}
