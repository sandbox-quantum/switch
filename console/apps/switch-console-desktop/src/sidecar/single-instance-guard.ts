import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sidecarReadyRelPath } from './sidecar-paths';

/**
 * Single-instance guard (CHOO-2653).
 *
 * Reads the existing ready file for this agent, checks whether its PID is still
 * alive, and probes its HTTP port. If a healthy sidecar is already running,
 * returns true — so the caller can exit cleanly instead of starting a duplicate
 * that would livelock the first.
 */
export async function existingSidecarIsHealthy(
  repoDir: string,
  stateSlug: string,
  log: { info(...input: unknown[]): void; warn(...input: unknown[]): void }
): Promise<boolean> {
  const readyPath = path.join(repoDir, sidecarReadyRelPath(stateSlug));
  let raw: string;
  try {
    raw = await readFile(readyPath, 'utf8');
  } catch {
    return false;
  }

  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return false;

  let parsed: { event?: string; pid?: number; port?: number; token?: string };
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }

  if (parsed.event !== 'ready') return false;
  if (typeof parsed.pid !== 'number' || parsed.pid === process.pid) return false;

  try {
    process.kill(parsed.pid, 0);
  } catch {
    return false; // process is gone
  }

  // PID is alive — probe its HTTP endpoint to confirm it is a sidecar and not
  // a recycled PID. The /sessions endpoint is token-gated and returns JSON.
  if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string') return false;
  try {
    const resp = await fetch(`http://127.0.0.1:${parsed.port}/sessions`, {
      headers: { Authorization: `Bearer ${parsed.token}` },
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      log.info('sidecar: another instance is already running for this agent', {
        existingPid: parsed.pid,
        existingPort: parsed.port,
      });
      return true;
    }
  } catch {
    // Port not responding — stale ready file with a recycled PID.
  }
  return false;
}
