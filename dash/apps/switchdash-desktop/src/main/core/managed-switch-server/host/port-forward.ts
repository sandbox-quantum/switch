import { createServer, type Server, type Socket } from 'node:net';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import { log } from '@main/lib/logger';

/**
 * A persistent local→remote loopback bridge over the SSH connection.
 *
 * For each port it opens a listener on the desktop's `127.0.0.1:<port>` and,
 * for every incoming connection, opens a direct-tcpip channel to the SAME port
 * on the remote host's loopback (via {@link SshClientProxy.forwardOut}) and
 * pipes the two together. Because the port number is mirrored, a single
 * `http://localhost:<port>` URL resolves to the same server whether the caller
 * runs on the desktop (through this bridge) or on the remote host (directly on
 * its loopback).
 *
 * The listeners are long-lived: they survive SSH reconnects because each
 * connection opens a fresh channel off the (stable) proxy at connect time — a
 * drop only kills in-flight connections, which reconnect on the next request.
 */
export class PortForwarder {
  private servers: Server[] = [];

  constructor(
    private readonly proxy: SshClientProxy,
    private readonly label: string
  ) {}

  /**
   * Start a mirrored listener for each port. Rejects (and tears down any
   * already-started listeners) if a local port cannot be bound — better to fail
   * the start loudly than register a URL that will not resolve.
   */
  async start(ports: number[]): Promise<void> {
    try {
      for (const port of ports) {
        await this.listen(port);
      }
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  private listen(port: number): Promise<void> {
    const server = createServer((socket) => this.bridge(socket, port));
    this.servers.push(server);
    return new Promise((resolve, reject) => {
      const onError = (err: Error) =>
        reject(new Error(`cannot bind local port ${port} for ${this.label}: ${err.message}`));
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        // Later listener errors are non-fatal — log rather than crash.
        server.on('error', (err) =>
          log.warn(`port-forward: listener error on :${port} (${this.label})`, { err })
        );
        resolve();
      });
    });
  }

  private bridge(socket: Socket, port: number): void {
    socket.on('error', () => socket.destroy());
    this.proxy
      .forwardOut(port)
      .then((channel) => {
        channel.on('error', () => socket.destroy());
        socket.on('close', () => channel.destroy());
        socket.pipe(channel);
        channel.pipe(socket);
      })
      .catch((err: unknown) => {
        log.warn(`port-forward: could not open channel to remote :${port} (${this.label})`, {
          err,
        });
        socket.destroy();
      });
  }

  /** Close all listeners. Idempotent. In-flight bridged sockets close with them. */
  stop(): void {
    for (const server of this.servers) {
      try {
        server.close();
      } catch {
        // Already closed.
      }
    }
    this.servers = [];
  }
}
