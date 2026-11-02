import { spawn } from 'node:child_process';
import { open, mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HostConnection } from './client';

export async function connectHost(
  root: string,
  executable: string,
  entrypoint: string,
  env: Record<string, string>
): Promise<HostConnection> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const endpointPath = join(root, 'endpoint.json');
  const ownerPath = join(root, 'owner.lock');
  const existing = async (): Promise<HostConnection | null> => {
    let raw: string;
    try {
      raw = await readFile(endpointPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const connection = new HostConnection(JSON.parse(raw));
    try {
      const response = await fetch(`${connection.endpoint.url}/health`, {
        headers: { authorization: `Bearer ${connection.endpoint.token}` },
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return connection;
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
    }
    return null;
  };
  const current = await existing();
  if (current) return current;
  try {
    const owner = await readFile(ownerPath, 'utf8');
    const pid = Number(owner);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid SDK host owner lock.');
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      await unlink(ownerPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const log = await open(join(root, 'host.log'), 'a', 0o600);
  let launchError: Error | null = null;
  try {
    const child = spawn(executable, [entrypoint, root], {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env,
    });
    child.once('error', (error) => {
      launchError = error;
    });
    child.unref();
  } finally {
    await log.close();
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    if (launchError) throw launchError;
    const connection = await existing();
    if (connection) return connection;
    await delay(100);
  }
  throw new Error('SDK host did not become ready. Check its host.log for the startup error.');
}
