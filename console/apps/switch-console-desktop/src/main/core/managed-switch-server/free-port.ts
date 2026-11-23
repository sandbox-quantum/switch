import { createServer } from 'node:net';
import { LOCAL_SERVER_BIND_ADDR } from './constants';

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
    postgres: await findFreePort(taken),
  };
}

export function isPorts(value: unknown): value is LocalServerPorts {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.gateway === 'number' && typeof v.api === 'number' && typeof v.postgres === 'number'
  );
}

/**
 * The address the managed stack is reached at on `port`. The IPv4 literal the
 * stack binds, never `localhost`: Node and Chromium both try `::1` first for
 * that name, and the stack holds only `127.0.0.1`, so any other local account
 * could listen on `[::1]:<port>` and be sent the admin password and session.
 */
export function loopbackUrl(port: number): string {
  return `http://${LOCAL_SERVER_BIND_ADDR}:${port}`;
}

/** Dashboard URL for a resolved port set. */
export function gatewayUrlFor(ports: LocalServerPorts): string {
  return loopbackUrl(ports.gateway);
}

/** Agent-bridge API URL for a resolved port set. */
export function apiUrlFor(ports: LocalServerPorts): string {
  return loopbackUrl(ports.api);
}

/**
 * Whether another program holds `[::1]:<port>`: bound there, it is what
 * anything reaching the stack as `localhost` gets first. A machine with no
 * IPv6 loopback has nothing to hold.
 */
export function ipv6LoopbackHeld(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(true);
      else if (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT') resolve(false);
      else reject(error);
    });
    server.listen({ port, host: '::1', ipv6Only: true }, () => server.close(() => resolve(false)));
  });
}

/**
 * Refuse a start when another program listens on the IPv6 loopback at one of
 * the stack's ports, in the words a failed bind uses so the start-failure
 * explainer offers to move the server to another port.
 */
export async function assertIpv6LoopbackFree(ports: number[]): Promise<void> {
  for (const port of ports) {
    if (await ipv6LoopbackHeld(port)) {
      throw new Error(
        `bind [::1]:${port}: address already in use. Another program is listening on the ` +
          `IPv6 loopback at the Switch server's port ${port}, where anything that reaches the ` +
          `server as localhost would go instead.`
      );
    }
  }
}

/**
 * The addresses a managed stack is registered with: switch-core's port as the
 * server's one address, and the dashboard container's port as where its pages
 * open. The compose Switch Console runs still starts that container, and the
 * switch-core it pins may predate serving the dashboard itself; once neither
 * holds, the dashboard address goes and so does this pairing.
 */
export function managedServerAddresses(ports: LocalServerPorts): {
  url: string;
  dashboardUrl: string;
} {
  return { url: apiUrlFor(ports), dashboardUrl: gatewayUrlFor(ports) };
}
