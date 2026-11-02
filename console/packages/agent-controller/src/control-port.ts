import { lstat, readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { ControlClient } from '@switch-console/agent-providers';
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
 * Level 3, from the launcher: hands a host the one-time ticket for its next hub
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
