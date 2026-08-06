import {
  buildSshCommand,
  SshExecutionContext,
} from '@main/core/execution-context/ssh-execution-context';
import type { IExecutionContext } from '@main/core/execution-context/types';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import { FileSystemError, FileSystemErrorCodes } from '@main/core/fs/types';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import type { SshClientProxy } from '@main/core/ssh/lifecycle/ssh-client-proxy';
import { log } from '@main/lib/logger';
import type { DockerAvailability } from '@shared/core/managed-switch-server/managed-switch-server';
import { REMOTE_SERVER_PROJECT_NAME } from '../constants';
import type { LocalServerPorts } from '../free-port';
import { remoteServerStateDir } from '../paths';
import { PortForwarder } from './port-forward';
import { pickRemoteFreePorts } from './remote-free-port';
import { ensureRemoteGhcrLogin } from './remote-ghcr-auth';
import { hostSlug, remoteSecretsKey } from './remote-identity';
import type { ServerHost } from './types';

/** Ports mirrored into a desktop-side forward so a single `localhost:<port>`
 * URL reaches the stack from both the desktop and the remote host. Postgres is
 * intentionally not forwarded — nothing on the desktop talks to it directly. */
const FORWARDED_SERVICES: (keyof LocalServerPorts)[] = ['gateway', 'api', 'mattermost'];

type RemoteHostDeps = {
  sshHost: string;
  proxy: SshClientProxy;
  /** Execution context rooted at {@link workingDir}. */
  ctx: SshExecutionContext;
  workingDir: string;
};

/**
 * A switchdash-managed Switch stack running on a remote host's Docker daemon
 * over SSH. Commands run via `SshExecutionContext` (a login shell `cd`'d into
 * the working dir); files are written over SFTP; ports are chosen free on both
 * loopbacks and bridged with a persistent mirrored forward so the desktop and
 * local agents reach `localhost:<port>` exactly as remote-host agents reach the
 * stack's own loopback.
 */
export class RemoteServerHost implements ServerHost {
  readonly kind = 'remote' as const;
  readonly dockerBin = 'docker';
  readonly composeProjectName = REMOTE_SERVER_PROJECT_NAME;
  readonly workingDir: string;
  readonly stateDir: string;
  readonly secretsKey: string;
  readonly label: string;
  readonly ctx: IExecutionContext;

  private readonly sshHost: string;
  private readonly proxy: SshClientProxy;
  private readonly fs: SshFileSystem;
  private forwarder: PortForwarder | null = null;

  constructor(deps: RemoteHostDeps) {
    this.sshHost = deps.sshHost;
    this.proxy = deps.proxy;
    this.ctx = deps.ctx;
    this.workingDir = deps.workingDir;
    this.label = deps.sshHost;
    this.stateDir = remoteServerStateDir(hostSlug(deps.sshHost));
    this.secretsKey = remoteSecretsKey(deps.sshHost);
    this.fs = new SshFileSystem(deps.proxy, deps.workingDir);
  }

  async writeFile(relPath: string, content: string, mode?: number): Promise<void> {
    await this.fs.write(relPath, content);
    if (mode !== undefined) {
      // ctx is rooted at workingDir, so the relative path resolves there.
      await this.ctx.exec('chmod', [mode.toString(8).padStart(3, '0'), relPath]);
    }
  }

  async readFile(relPath: string): Promise<string | null> {
    try {
      const { content } = await this.fs.read(relPath);
      return content;
    } catch (error) {
      if (error instanceof FileSystemError && error.code === FileSystemErrorCodes.NOT_FOUND) {
        return null;
      }
      throw error;
    }
  }

  streamCommand(
    command: string,
    args: string[],
    onLine: (line: string) => void,
    opts: { timeoutMs?: number } = {}
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.proxy
        .getRemoteShellProfile()
        .then((profile) => {
          const full = buildSshCommand(this.workingDir, command, args, profile);
          this.proxy.exec(full, (execErr, stream) => {
            if (execErr) {
              reject(execErr);
              return;
            }
            let stderrTail = '';
            let settled = false;
            const emit = (buf: Buffer) => {
              for (const raw of buf.toString('utf8').split('\n')) {
                const line = raw.replace(/\r$/, '');
                if (line.length > 0) onLine(line);
              }
            };
            const settle = (fn: () => void) => {
              if (settled) return;
              settled = true;
              if (timer) clearTimeout(timer);
              fn();
            };
            const timer =
              opts.timeoutMs !== undefined
                ? setTimeout(() => {
                    settle(() => {
                      stream.destroy();
                      reject(new Error(`${command} timed out after ${opts.timeoutMs}ms`));
                    });
                  }, opts.timeoutMs)
                : undefined;
            stream.on('data', emit);
            stream.stderr.on('data', (buf: Buffer) => {
              stderrTail = (stderrTail + buf.toString('utf8')).slice(-4000);
              emit(buf);
            });
            stream.on('close', (code: number | null) => {
              settle(() => {
                if ((code ?? 0) === 0) resolve();
                else reject(new Error(`${command} failed (exit ${code}): ${stderrTail.trim()}`));
              });
            });
            stream.on('error', (err: Error) => settle(() => reject(err)));
          });
        })
        .catch(reject);
    });
  }

  async detectDocker(): Promise<DockerAvailability> {
    try {
      const { stdout } = await this.ctx.exec(
        'docker',
        ['version', '--format', '{{.Server.Version}}'],
        { timeout: 20_000 }
      );
      const version = stdout.trim();
      if (!version) {
        return {
          available: false,
          reason: 'daemon-down',
          detail: `Docker on ${this.label} reported no server version.`,
        };
      }
      return { available: true, version };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not found|command not found|no such file/i.test(message)) {
        return {
          available: false,
          reason: 'not-installed',
          detail: `The Docker CLI was not found on ${this.label}.`,
        };
      }
      if (
        /cannot connect to the docker daemon|is the docker daemon running|permission denied/i.test(
          message
        )
      ) {
        return {
          available: false,
          reason: 'daemon-down',
          detail: `Docker is installed on ${this.label} but its daemon is not reachable (start it, or add your user to the docker group).`,
        };
      }
      return { available: false, reason: 'daemon-down', detail: message };
    }
  }

  ensureGhcrLogin(): Promise<void> {
    return ensureRemoteGhcrLogin({
      ctx: this.ctx,
      writeFile: (relPath, content, mode) => this.writeFile(relPath, content, mode),
      label: this.label,
    });
  }

  pickFreePorts(): Promise<LocalServerPorts> {
    return pickRemoteFreePorts(this.ctx);
  }

  async establishNetworking(ports: LocalServerPorts): Promise<void> {
    this.forwarder?.stop();
    const forwarder = new PortForwarder(this.proxy, this.label);
    await forwarder.start(FORWARDED_SERVICES.map((s) => ports[s]));
    this.forwarder = forwarder;
    log.info(
      `remote-switch-server: forwarding ${FORWARDED_SERVICES.join(', ')} from ${this.label}`
    );
  }

  async teardownNetworking(): Promise<void> {
    this.forwarder?.stop();
    this.forwarder = null;
  }

  dispose(): void {
    this.forwarder?.stop();
    this.forwarder = null;
    this.fs.close();
    this.ctx.dispose();
  }
}

/**
 * Connect to a remote host and build its {@link RemoteServerHost}. Ensures the
 * pooled SSH connection is up, resolves the remote home, and creates the working
 * dir so the rooted execution context and SFTP writes are valid from the first
 * command.
 */
export async function createRemoteServerHost(sshHost: string): Promise<RemoteServerHost> {
  const proxy = await ensureSshConnected(sshConnectionIdForHost(sshHost), sshHost);
  const probe = new SshExecutionContext(proxy);
  const { stdout } = await probe.exec('sh', ['-c', 'printf %s "$HOME"']);
  const home = stdout.trim();
  if (!home) {
    throw new Error(`Could not resolve the home directory on ${sshHost}.`);
  }
  const workingDir = `${home}/.switchdash/switch-server`;
  await probe.exec('mkdir', ['-p', workingDir]);
  probe.dispose();
  const ctx = new SshExecutionContext(proxy, { root: workingDir });
  return new RemoteServerHost({ sshHost, proxy, ctx, workingDir });
}
