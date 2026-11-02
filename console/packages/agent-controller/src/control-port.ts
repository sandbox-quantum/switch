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
  const link = await lstat(controlFile);
  if (!link.isFile()) throw new Error(`${controlFile} is not a regular file.`);
  if (link.size > CONTROL_FILE_LIMIT_BYTES) throw new Error(`${controlFile} is too large.`);
  const { port, token } = controlFileSchema.parse(JSON.parse(await readFile(controlFile, 'utf8')));
  const client = new ControlClient(connect({ host: '127.0.0.1', port }), token);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.ready.then(() => client.warm(roomId)),
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
