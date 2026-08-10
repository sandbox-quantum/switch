import { createServer } from 'node:net';

/**
 * Host ports the managed stack publishes. The compose binds these to 127.0.0.1
 * via `${<NAME>_HOST_PORT}` interpolation; the *container-side* ports are fixed
 * by the images, only the host side is chosen. Picked once from whatever is free
 * on this machine and persisted, so a dev already running something on 8000 /
 * 5432 / 3000 never hits a "port is already allocated" failure.
 */
export type LocalServerPorts = {
  /** Operator gateway (dashboard) — what "Open admin interface" and management calls use. */
  gateway: number;
  /** switch-core agent bridge API — a connector's `SWITCH_API_ENDPOINT`. */
  api: number;
  /** Mattermost web UI. */
  mattermost: number;
  /** Postgres (host-side, for debugging; the stack talks to it over the network). */
  postgres: number;
};

/**
 * Ask the OS for a free TCP port on loopback: bind to :0, let the kernel assign
 * an unused port, read it back, release it. `taken` holds ports already chosen in
 * this batch — the socket is closed before the next pick, so without it two picks
 * could be handed the same port.
 */
export async function findFreePort(taken: Set<number>): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = createServer();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const p = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close(() => resolve(p));
      });
    });
    if (port && !taken.has(port)) {
      taken.add(port);
      return port;
    }
  }
  throw new Error('Could not find a free local port after 50 attempts.');
}

/** Pick a distinct free port for each service the stack publishes. */
export async function pickFreePorts(): Promise<LocalServerPorts> {
  const taken = new Set<number>();
  return {
    gateway: await findFreePort(taken),
    api: await findFreePort(taken),
    mattermost: await findFreePort(taken),
    postgres: await findFreePort(taken),
  };
}

export function isPorts(value: unknown): value is LocalServerPorts {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.gateway === 'number' &&
    typeof v.api === 'number' &&
    typeof v.mattermost === 'number' &&
    typeof v.postgres === 'number'
  );
}

/** Dashboard URL for a resolved port set. */
export function gatewayUrlFor(ports: LocalServerPorts): string {
  return `http://localhost:${ports.gateway}`;
}

/** Agent-bridge API URL for a resolved port set. */
export function apiUrlFor(ports: LocalServerPorts): string {
  return `http://localhost:${ports.api}`;
}
