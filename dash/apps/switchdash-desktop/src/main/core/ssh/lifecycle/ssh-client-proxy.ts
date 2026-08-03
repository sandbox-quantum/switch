import type { Client, ClientCallback, ClientChannel, ClientSFTPCallback, ExecOptions } from 'ssh2';
import { log } from '@main/lib/logger';
import { captureRemoteShellProfile, type RemoteShellProfile } from './remote-shell-profile';
import { disableAgentForwarding, isAgentForwardRefusal } from './ssh-agent-forward-refusal';
import { SshChannelTimeoutError } from './ssh-channel-open-failure';

type RemoteShellProfileState =
  | { kind: 'empty' }
  | {
      kind: 'loading';
      client: Client;
      mode: 'get' | 'refresh';
      promise: Promise<RemoteShellProfile>;
    }
  | { kind: 'ready'; client: Client; profile: RemoteShellProfile };

/**
 * Stable reference to an ssh2 Client that survives reconnects.
 *
 * Services like SshFileSystem and SshGitService hold a SshClientProxy
 * rather than a raw Client. SshConnectionManager calls update() each time
 * a connection is established (including after reconnect) and invalidate()
 * when the connection drops. Callers that access proxy.client at call time
 * therefore always get the current live Client without needing to be
 * rebuilt or replaced.
 */
/**
 * Max concurrent short-lived `exec` (command) channels per connection. SSH
 * servers cap simultaneous sessions (OpenSSH MaxSessions defaults to 10, and
 * proxies/tunnels can be lower); bursts of parallel probes (dependency checks,
 * plugin status, gh auth) otherwise trip "Channel open failure: open failed".
 * Long-lived PTY channels (execPty) are intentionally not counted here.
 */
const MAX_CONCURRENT_EXEC = 4;

/**
 * Deadline for the server to answer a channel open (exec / pty / direct-tcpip
 * / sftp). Healthy opens answer in milliseconds; a silent open is the
 * signature of a half-dead transport, and an unanswered open used to hang its
 * caller (and leak its exec slot) forever. The error is reported to the health
 * reporter so the connection manager's wedge watchdog can force a rebuild.
 */
const CHANNEL_OPEN_TIMEOUT_MS = 15_000;

export interface SshChannelHealthReporter {
  reportChannelError(connectionId: string, error: unknown): void;
  reportChannelSuccess?(connectionId: string): void;
}

export class SshClientProxy {
  private _client: Client | null = null;
  private _remoteShellProfileState: RemoteShellProfileState = { kind: 'empty' };

  /** Semaphore state for short-lived exec channels. */
  private activeExec = 0;
  private readonly execQueue: Array<() => void> = [];

  constructor(
    readonly connectionId: string,
    private healthReporter?: SshChannelHealthReporter
  ) {}

  /** Called by SshConnectionManager when a connection becomes ready. */
  update(client: Client): void {
    if (this._client !== client) {
      this._remoteShellProfileState = { kind: 'empty' };
    }
    this._client = client;
  }

  async getRemoteShellProfile(): Promise<RemoteShellProfile> {
    const client = this.client;
    const state = this._remoteShellProfileState;

    if (state.kind === 'ready' && state.client === client) {
      return state.profile;
    }
    if (state.kind === 'loading' && state.client === client) {
      return state.promise;
    }

    return this.captureRemoteShellProfileFor(client, 'get');
  }

  async refreshRemoteShellProfile(): Promise<RemoteShellProfile> {
    const client = this.client;
    const state = this._remoteShellProfileState;

    if (state.kind === 'loading' && state.client === client && state.mode === 'refresh') {
      return state.promise;
    }

    return this.captureRemoteShellProfileFor(client, 'refresh');
  }

  private captureRemoteShellProfileFor(
    client: Client,
    mode: 'get' | 'refresh'
  ): Promise<RemoteShellProfile> {
    const promise = captureRemoteShellProfile(this).then((profile) => {
      if (
        this._client === client &&
        this._remoteShellProfileState.kind === 'loading' &&
        this._remoteShellProfileState.promise === promise
      ) {
        this._remoteShellProfileState = { kind: 'ready', client, profile };
      }
      return profile;
    });
    this._remoteShellProfileState = { kind: 'loading', client, mode, promise };
    return promise;
  }

  /**
   * Turn a server's refusal of agent forwarding into a degraded connection
   * rather than a dead one. Returns true when forwarding was just switched off
   * and the caller should retry its channel open once.
   *
   * The capability is optional — switchdash needs none of it, and it is only
   * requested because the user's ssh config asks for it — so a host that
   * declines it (`AllowAgentForwarding no`) must not lose every remote command.
   * The loss is real for anything on the host relying on the forwarded agent
   * (e.g. `git push` over SSH with the user's local keys), hence the warning.
   */
  private recoverFromAgentForwardRefusal(error: unknown): boolean {
    if (!this._client || !isAgentForwardRefusal(error)) return false;
    if (!disableAgentForwarding(this._client)) return false;
    log.warn('SshClientProxy: host refused agent forwarding, continuing without it', {
      event: 'ssh.agent_forward_refused',
      connectionId: this.connectionId,
    });
    return true;
  }

  /** Run `fn` once an exec slot is free; queues it when at capacity. */
  private acquireExecSlot(fn: () => void): void {
    if (this.activeExec < MAX_CONCURRENT_EXEC) {
      this.activeExec++;
      fn();
    } else {
      this.execQueue.push(fn);
    }
  }

  /** Free an exec slot and start the next queued command, if any. */
  private releaseExecSlot(): void {
    const next = this.execQueue.shift();
    if (next) {
      next();
    } else {
      // A slot released after invalidate() already reset the counter (e.g. a
      // dead channel's close event straggling in) must not drive it negative.
      this.activeExec = Math.max(0, this.activeExec - 1);
    }
  }

  /**
   * Guard a channel-open callback with the open deadline. Returns a wrapped
   * callback; when the deadline fires first, `callback` receives an
   * SshChannelTimeoutError (reported to the health reporter) and a channel
   * delivered late is destroyed rather than leaked.
   */
  private withChannelOpenTimeout(what: string, callback: ClientCallback): ClientCallback {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new SshChannelTimeoutError(
        `SSH ${what} channel open timed out after ${CHANNEL_OPEN_TIMEOUT_MS}ms`
      );
      this.reportChannelResult(error);
      callback(error as Error & { code: number }, undefined as never);
    }, CHANNEL_OPEN_TIMEOUT_MS);

    return (err, channel) => {
      if (settled) {
        // Late arrival after the deadline fired — close it rather than leak it.
        // SFTP subsystem channels expose end() instead of destroy().
        const closable = channel as { destroy?: () => void; end?: () => void } | undefined;
        if (closable?.destroy) closable.destroy();
        else closable?.end?.();
        return;
      }
      settled = true;
      clearTimeout(timer);
      this.reportChannelResult(err);
      callback(err, channel);
    };
  }

  exec(command: string, callback: ClientCallback): void;
  exec(command: string, options: ExecOptions, callback: ClientCallback): void;
  exec(
    command: string,
    optionsOrCallback: ExecOptions | ClientCallback,
    callback?: ClientCallback
  ): void {
    const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
    const userCallback = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;

    this.acquireExecSlot(() => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.releaseExecSlot();
      };

      const attempt = (retrying: boolean): void => {
        const wrappedCallback = this.withChannelOpenTimeout('exec', (err, channel) => {
          if (err && !retrying && this.recoverFromAgentForwardRefusal(err)) {
            attempt(true);
            return;
          }
          if (!err && channel && typeof channel.once === 'function') {
            // Free the slot when the command's channel finishes.
            channel.once('close', release);
            channel.once('error', release);
          } else {
            release();
          }
          userCallback?.(err, channel);
        });

        try {
          if (options) {
            this.client.exec(command, options, wrappedCallback);
          } else {
            this.client.exec(command, wrappedCallback);
          }
        } catch (err) {
          // e.g. connection not available — surface via callback, don't leak the slot.
          release();
          userCallback?.(err as Error, undefined as never);
        }
      };

      attempt(false);
    });
  }

  execPty(command: string, options: ExecOptions, callback: ClientCallback): void {
    // The timeout guards only the channel OPEN; the pty channel itself is
    // long-lived (it is the interactive terminal).
    const attempt = (retrying: boolean): void => {
      this.client.exec(
        command,
        options,
        this.withChannelOpenTimeout('pty', (err, channel) => {
          if (err && !retrying && this.recoverFromAgentForwardRefusal(err)) {
            attempt(true);
            return;
          }
          callback(err, channel);
        })
      );
    };

    attempt(false);
  }

  /**
   * Open a direct-tcpip channel to `127.0.0.1:<dstPort>` on the remote host —
   * used to reach a VM-local service (e.g. the sidecar's hook server) over the
   * existing SSH connection without exposing a port. Resolves with the channel,
   * which is a duplex stream usable as an HTTP socket. Rejects with
   * SshChannelTimeoutError when the server never answers the open.
   */
  forwardOut(dstPort: number): Promise<ClientChannel> {
    return new Promise<ClientChannel>((resolve, reject) => {
      const wrapped = this.withChannelOpenTimeout('direct-tcpip', (err, channel) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(channel);
      });
      try {
        this.client.forwardOut('127.0.0.1', 0, '127.0.0.1', dstPort, wrapped);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  sftp(callback: ClientSFTPCallback): void {
    const wrapped = this.withChannelOpenTimeout('sftp', callback as unknown as ClientCallback);
    this.client.sftp(wrapped as unknown as ClientSFTPCallback);
  }

  private reportChannelResult(err: Error | undefined): void {
    if (err) {
      this.healthReporter?.reportChannelError(this.connectionId, err);
      return;
    }
    this.healthReporter?.reportChannelSuccess?.(this.connectionId);
  }

  /**
   * Called by SshConnectionManager when the connection drops. Fails every
   * queued exec (their callbacks fire with "SSH connection is not available")
   * and resets the slot counter: in-flight channels on the dead client may
   * never emit `close`, and without the reset their leaked slots would starve
   * the semaphore forever — surviving even a successful reconnect.
   */
  invalidate(): void {
    this._client = null;
    this._remoteShellProfileState = { kind: 'empty' };
    const queued = this.execQueue.splice(0);
    this.activeExec = 0;
    for (const fn of queued) {
      // Each queued fn re-checks `this.client`, which now throws — the caller
      // gets an immediate error instead of waiting on a slot that never frees.
      this.activeExec++;
      fn();
    }
  }

  /**
   * The live ssh2 Client. Throws if the connection is not currently
   * established. Callers should check isConnected first if they want to
   * avoid throwing.
   */
  get client(): Client {
    if (!this._client) {
      throw new Error('SSH connection is not available');
    }
    return this._client;
  }

  /** True while an active connection is held. */
  get isConnected(): boolean {
    return this._client !== null;
  }
}
