import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isPorts, type LocalServerPorts, pickFreePorts } from './free-port';
import { localServerDir } from './paths';

function portsFilePath(): string {
  return join(localServerDir(), 'ports.json');
}

async function loadPersisted(): Promise<LocalServerPorts | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(portsFilePath(), 'utf8'));
    return isPorts(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function persist(ports: LocalServerPorts): Promise<void> {
  await mkdir(dirname(portsFilePath()), { recursive: true });
  await writeFile(portsFilePath(), JSON.stringify(ports, null, 2), 'utf8');
}

/**
 * The ports the managed stack should publish on. Reuses the persisted choice if
 * present — the running containers are already bound to those, and reusing keeps
 * the server's URLs stable across restarts — otherwise picks free ports once and
 * persists them.
 */
export async function resolvePorts(): Promise<LocalServerPorts> {
  const existing = await loadPersisted();
  if (existing) return existing;
  const chosen = await pickFreePorts();
  await persist(chosen);
  return chosen;
}

/** Drop the persisted choice so the next start picks fresh ports (reset path). */
export async function clearPorts(): Promise<void> {
  try {
    await writeFile(portsFilePath(), JSON.stringify({}), 'utf8');
  } catch {
    // Best-effort: a missing file is already the desired state.
  }
}
