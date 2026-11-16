import { createServer } from 'node:net';
import type { LocalServerPorts } from '../free-port';

/** Whether `port` can be bound on loopback right now. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/**
 * Refuse a start whose ports something else has taken since they were chosen,
 * in the words a failed bind uses, so the start-failure explainer names the
 * port and offers to move the server to another one. Every port the server
 * listens on is checked: switch-core's, PostgreSQL's, the callback listener's
 * and, when it runs, Mattermost's.
 */
export async function assertPortsFree(ports: LocalServerPorts, mattermost: boolean): Promise<void> {
  const listening = [ports.api, ports.gateway, ports.postgres];
  if (mattermost) listening.push(ports.mattermost);
  for (const port of listening) {
    if (!(await portFree(port))) {
      throw new Error(`bind 127.0.0.1:${port}: address already in use`);
    }
  }
}
