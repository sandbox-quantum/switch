import { connect } from 'node:net';
import { ControlClient, parseUntrustedJson, readUntrusted } from '@switch-console/agent-providers';
import { z } from 'zod';

const CONTROL_FILE_LIMIT_BYTES = 4096;
const CONNECT_TIMEOUT_MS = 5_000;

const controlFileSchema = z.strictObject({
  port: z.number().int().min(1024).max(65535),
  token: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
});

/**
 * Ask an agent host in a process of its own to warm `roomId`, over the
 * loopback control port named in its `control.json`.
 */
export async function warmOverControlPort(controlFile: string, roomId: string): Promise<void> {
  await overControlPort(controlFile, (client) => client.warm(roomId));
}

/**
 * One request to an agent host in a process of its own, over the loopback
 * control port named in its `control.json`. The file is the agent's, so it is
 * read as untrusted: not through a symlink, small, a port and a token.
 * `checkPort`, when given, sees the port before anything connects to it and
 * may throw to refuse it.
 */
export async function overControlPort<T>(
  controlFile: string,
  ask: (client: ControlClient) => Promise<T>,
  checkPort?: (port: number) => Promise<void>
): Promise<T> {
  const text = await readUntrusted(controlFile, { maxBytes: CONTROL_FILE_LIMIT_BYTES });
  if (text === null) throw new Error(`${controlFile} does not exist; is the agent host running?`);
  const { port, token } = parseUntrustedJson(text, controlFileSchema, controlFile);
  if (checkPort) await checkPort(port);
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
