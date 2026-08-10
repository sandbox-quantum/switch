import type { IExecutionContext } from '@main/core/execution-context/types';
import { listManagedServers } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';
import { findFreePort, type LocalServerPorts } from '../free-port';

/**
 * TCP ports currently in LISTEN state on the remote host, so a stack we bring up
 * never tries to publish onto one already in use there. Best-effort: parses
 * `ss`/`netstat` output; an empty set (tools missing / parse miss) just means we
 * rely on the desktop-side free check plus a loud failure at `compose up`.
 */
export async function listRemoteListeningPorts(ctx: IExecutionContext): Promise<Set<number>> {
  const ports = new Set<number>();
  try {
    const { stdout } = await ctx.exec('sh', [
      '-c',
      'ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null',
    ]);
    for (const line of stdout.split('\n')) {
      // Grab every `:<port>` on the line (the local address is `…:<port>`; the
      // peer column is `*`/`:::*` with no bare number, so over-collection is
      // harmless — it only makes us skip a few extra ports).
      for (const m of line.matchAll(/:(\d{1,5})\b/g)) {
        const port = Number.parseInt(m[1]!, 10);
        if (port > 0 && port < 65536) ports.add(port);
      }
    }
  } catch (error) {
    log.warn('remote-switch-server: could not list remote listening ports', { error });
  }
  return ports;
}

/** Host ports already claimed by other managed servers (the local stack and any
 * other remote hosts), parsed from their registered URLs. Mirrored remote ports
 * are bound on the desktop loopback too, so two managed stacks must not share a
 * number — this keeps the desktop listeners (and the unique gateway-URL index)
 * from colliding. */
async function reservedManagedPorts(): Promise<Set<number>> {
  const reserved = new Set<number>();
  for (const server of await listManagedServers()) {
    for (const url of [server.gatewayUrl, server.apiUrl]) {
      const port = Number.parseInt(new URL(url).port, 10);
      if (Number.isFinite(port) && port > 0) reserved.add(port);
    }
  }
  return reserved;
}

/**
 * Pick a distinct port for each service, free on BOTH loopbacks: chosen free on
 * the desktop (so the mirrored forward listener can bind it) and neither already
 * listening on the remote host nor claimed by another managed server. The same
 * number is then used on the remote (published) and the desktop (forwarded), so
 * one URL works everywhere.
 */
export async function pickRemoteFreePorts(ctx: IExecutionContext): Promise<LocalServerPorts> {
  const taken = new Set<number>([
    ...(await reservedManagedPorts()),
    ...(await listRemoteListeningPorts(ctx)),
  ]);
  return {
    gateway: await findFreePort(taken),
    api: await findFreePort(taken),
    mattermost: await findFreePort(taken),
    postgres: await findFreePort(taken),
  };
}
