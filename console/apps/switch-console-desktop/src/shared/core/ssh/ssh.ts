/**
 * SSH connection types for Switch Console remote agents (CHOO-1059). Ported from
 * Switch Console and trimmed: Switch Console resolves a connection from the agent's
 * `~/.ssh/config` Host alias rather than storing connections in a table, and
 * uses typed RPC instead of Switch Console's ssh: IPC channels.
 */

/**
 * The resolved inputs for opening an SSH connection. In Switch Console this is
 * derived from a remote agent's `sshHost` alias (resolved via `ssh -G`), not
 * persisted as a row. `name` is a human label for error messages.
 */
export interface SshConfig {
  name: string;
  host: string;
  port: number;
  username: string;
  sshConfigAlias?: string;
  authType: 'password' | 'key' | 'agent';
  privateKeyPath?: string;
  useAgent?: boolean;
  forwardAgent?: boolean;
  proxyJump?: string;
}

/** Current state of an SSH connection. */
export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

export type SshHealthState = { status: 'ok' } | { status: 'degraded' };

/** Result of an ad-hoc SSH connection test. */
export interface ConnectionTestResult {
  success: boolean;
  error?: string;
  latency?: number;
  serverVersion?: string;
  debugLogs?: string[];
}

/** A file or directory on a remote host (SFTP). */
export interface FileEntry {
  path: string;
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modifiedAt: Date;
  permissions?: string;
}

/** Result of executing a command on a remote host. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** A Host alias parsed from `~/.ssh/config` (best-effort, for UI listing). */
export interface SshConfigHost {
  host: string;
  hostname?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  identityAgent?: string;
  proxyJump?: string;
  proxyCommand?: string;
  forwardAgent?: boolean;
  forwardAgentValue?: string;
}
