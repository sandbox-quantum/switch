import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isPorts, type LocalServerPorts } from './free-port';
import type { ServerHost } from './host/types';

/** Reading the persisted choice only needs the state directory — not a live
 * host — so these take the narrowest shape that works. */
type HostStateDir = Pick<ServerHost, 'stateDir'>;

function portsFilePath(host: HostStateDir): string {
  return join(host.stateDir, 'ports.json');
}

async function loadPersisted(host: HostStateDir): Promise<LocalServerPorts | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(portsFilePath(host), 'utf8'));
    return isPorts(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function persist(host: ServerHost, ports: LocalServerPorts): Promise<void> {
  await mkdir(dirname(portsFilePath(host)), { recursive: true });
  await writeFile(portsFilePath(host), JSON.stringify(ports, null, 2), 'utf8');
}

/**
 * The ports the managed stack should publish on. Reuses the persisted choice if
 * present — the running containers are already bound to those, and reusing keeps
 * the server's URLs stable across restarts (so an API-URL cascade to agents is
 * not needed every start) — otherwise picks free ports once (via the host, which
 * for a remote host ensures the numbers are free on both loopbacks) and
 * persists them.
 */
export async function resolvePorts(host: ServerHost): Promise<LocalServerPorts> {
  const existing = await loadPersisted(host);
  if (existing) return existing;
  const chosen = await host.pickFreePorts();
  await persist(host, chosen);
  return chosen;
}

/** The persisted port choice for a host, or null if none has been chosen yet.
 * Used at boot to re-establish a remote forward only when we know the ports the
 * running containers are actually bound to (picking fresh here would forward to
 * the wrong ports). */
export function readPersistedPorts(host: HostStateDir): Promise<LocalServerPorts | null> {
  return loadPersisted(host);
}

/** Keep `ports` as this desktop's record of the ports a host's stack publishes
 * — the numbers read off the host itself when a remote stack's settings are
 * adopted from there (CHOO-2893). */
export async function rememberPorts(host: ServerHost, ports: LocalServerPorts): Promise<void> {
  await persist(host, ports);
}

/** Drop the persisted choice so the next start picks fresh ports (reset path),
 * or so a Console that disconnects keeps nothing of a stack it no longer uses. */
export async function clearPorts(host: HostStateDir): Promise<void> {
  try {
    await writeFile(portsFilePath(host), JSON.stringify({}), 'utf8');
  } catch {
    // Best-effort: a missing file is already the desired state.
  }
}
