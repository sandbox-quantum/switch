import type { IExecutionContext } from '@main/core/execution-context/types';
import type { DockerAvailability } from '@shared/core/managed-switch-server/managed-switch-server';
import type { LocalServerPorts } from '../free-port';

/**
 * A host that runs a switchdash-managed Switch stack via `docker compose`.
 *
 * Abstracts everything that differs between the local Docker daemon and a
 * remote host's daemon reached over SSH, so the compose pipeline
 * (compose up / health / register / stop / reset) is transport-agnostic:
 *
 * - `ctx` runs commands on the host (local spawn vs SSH exec), rooted at
 *   `workingDir` so `docker compose -f <relative>` resolves.
 * - `writeFile` materialises the compose file and generated `.env` on the host.
 * - `pickFreePorts` chooses host ports; the remote host additionally requires
 *   the same numbers to be free on the desktop's loopback (see remote host).
 * - `establishNetworking` makes the published ports reachable from the desktop
 *   (a no-op locally; a persistent mirrored SSH forward remotely) so the same
 *   `http://localhost:<port>` URL works for the desktop and local agents.
 *
 * One host instance backs one start/stop/reset operation and is disposed after.
 */
export interface ServerHost {
  readonly kind: 'local' | 'remote';

  /** Execution context rooted at {@link workingDir}. */
  readonly ctx: IExecutionContext;

  /** Docker executable to invoke on the host (an absolute path locally; the
   * bare `docker` resolved via the login shell remotely). */
  readonly dockerBin: string;

  /** `docker compose --project-name` scoping the managed stack's containers and
   * volumes on the host's daemon. */
  readonly composeProjectName: string;

  /** Directory on the host holding the compose file + generated `.env`. */
  readonly workingDir: string;

  /** Local (desktop) directory where switchdash persists this host's own
   * metadata — the chosen port set (`ports.json`). Equals {@link workingDir}
   * for the local host; a per-host dir under user-data for a remote host, since
   * its working dir lives on the remote machine. */
  readonly stateDir: string;

  /** Encrypted-store key under which this host's stack secret bundle is kept.
   * Distinct per host so a local and one/more remote managed stacks never share
   * (or clobber) each other's credentials. */
  readonly secretsKey: string;

  /** Human-readable label for the host, used in log lines ("this computer" /
   * the SSH alias). */
  readonly label: string;

  /** Write `content` to `relPath` under {@link workingDir}, creating parent
   * directories. `mode` (e.g. 0o600 for the secret-bearing `.env`) is enforced
   * when provided. */
  writeFile(relPath: string, content: string, mode?: number): Promise<void>;

  /**
   * Run a command on the host streaming merged stdout+stderr line-by-line to
   * `onLine`, rooted at {@link workingDir}. Used for the slow `compose up`
   * (docker emits pull/startup progress on stderr, so both streams are
   * forwarded for the UI tail). Rejects on non-zero exit or timeout.
   */
  streamCommand(
    command: string,
    args: string[],
    onLine: (line: string) => void,
    opts?: { timeoutMs?: number }
  ): Promise<void>;

  /** Whether Docker is usable on the host (CLI resolves AND daemon answers). */
  detectDocker(): Promise<DockerAvailability>;

  /** Authenticate the host's Docker to GHCR so the private release images pull
   * before the public-repo flip (CHOO-1260). Best-effort: warns and proceeds
   * when no credentials are available, so a public image is a no-op and a
   * private one fails loudly on the subsequent pull. */
  ensureGhcrLogin(): Promise<void>;

  /** Free host ports for the stack to publish on the host's loopback. The
   * remote host picks numbers free on BOTH the remote and the desktop loopback,
   * so the same number can be mirrored by the local forward. */
  pickFreePorts(): Promise<LocalServerPorts>;

  /** Make the published ports reachable from the desktop at
   * `http://localhost:<port>`. Local: no-op (already on loopback). Remote:
   * start persistent mirrored port-forward listeners (same number both sides)
   * over the SSH connection, kept alive across reconnects. */
  establishNetworking(ports: LocalServerPorts): Promise<void>;

  /** Tear down any networking started by {@link establishNetworking}. Called on
   * stop/reset and disposal. Idempotent. */
  teardownNetworking(): Promise<void>;

  /** Release resources (execution context, forwards). Idempotent. */
  dispose(): void;
}
