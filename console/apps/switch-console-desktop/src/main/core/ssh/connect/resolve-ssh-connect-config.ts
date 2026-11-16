// Builds the ssh2 ConnectConfig for a remote agent. Ported from Switch Console and
// trimmed for Switch Console (CHOO-1059): connections are never persisted as rows,
// so this only handles the transient path, and a remote agent always carries an
// `~/.ssh/config` Host alias — the canonical OpenSSH resolution via `ssh -G` is
// the source of truth. The manual-agent (no-alias hostname lookup) and
// credential-service password paths from Switch Console are dropped.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getWindowsEnvValue } from '@switch-console/core/exec';
import ssh2, { type BaseAgent, type ConnectConfig } from 'ssh2';
import { detectWindowsOpenSshAgentPipe } from '@main/utils/shellEnv';
import type { SshConfig } from '@shared/core/ssh/ssh';
import {
  resolveSshConfig as defaultResolveSshConfig,
  type ResolvedSshConfig,
} from '../config/resolve-ssh-config';
import type {
  HostKeyTarget,
  PreparedHostKeyCheck,
  SshHostKeyError,
} from '../host-keys/host-key-check';
import {
  spawnProxyCommand as defaultSpawnProxyCommand,
  spawnProxyJump as defaultSpawnProxyJump,
  type ProxyTokens,
  type TransportResult,
} from '../transport/transports';
import { buildAuthConfig } from './ssh-connect-auth';
import { applyForwardAgent } from './ssh-connect-forward-agent';

const { createAgent } = ssh2;

export interface SshConnectResult {
  config: ConnectConfig;
  cleanup: () => void;
  debugLogs: string[];
  /**
   * Why the host key check refused the connection, if it did. ssh2 reports a
   * refused key only as a generic handshake error.
   */
  hostKeyRejection: () => SshHostKeyError | undefined;
}

/** Builds the host key check for one connection attempt. */
export type HostKeyChecker = (target: HostKeyTarget) => Promise<PreparedHostKeyCheck>;

export type TransientConnectInput = {
  kind: 'transient';
  config: SshConfig & { password?: string; passphrase?: string };
};
export type SshConnectInput = TransientConnectInput;

export interface SshConnectDeps {
  readFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  resolveSshConfig: (alias: string) => Promise<ResolvedSshConfig>;
  spawnProxyCommand: (command: string, tokens: ProxyTokens) => Omit<TransportResult, 'process'>;
  spawnProxyJump: (
    jumpSpec: string,
    destHost: string,
    destPort: number
  ) => Omit<TransportResult, 'process'>;
  createAgent: (socketPath: string) => BaseAgent;
  env: Record<string, string | undefined>;
}

/**
 * The environment Console's own SSH connections resolve their agent from.
 *
 * Windows OpenSSH's agent is a named pipe and never sets `SSH_AUTH_SOCK`, so
 * when it is unset on Windows the running agent's pipe is filled in here. It is
 * not put in `process.env`: Git Bash, MSYS and WSL tools inherit that and
 * expect a unix socket in `SSH_AUTH_SOCK`.
 */
export function sshConnectEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  detectWindowsAgentPipe: () => string | undefined
): Record<string, string | undefined> {
  if (platform !== 'win32' || getWindowsEnvValue(env, 'SSH_AUTH_SOCK')) return env;
  const pipe = detectWindowsAgentPipe();
  return pipe ? { ...env, SSH_AUTH_SOCK: pipe } : env;
}

function defaultDeps(): SshConnectDeps {
  return {
    readFile,
    resolveSshConfig: (alias) => defaultResolveSshConfig(alias),
    spawnProxyCommand: (command, tokens) => defaultSpawnProxyCommand(command, tokens),
    spawnProxyJump: (jumpSpec, destHost, destPort) =>
      defaultSpawnProxyJump(jumpSpec, destHost, destPort),
    createAgent,
    env: sshConnectEnv(process.env, process.platform, detectWindowsOpenSshAgentPipe),
  };
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

/**
 * What the host key is checked against. With an alias it is whatever `ssh -G`
 * resolved for it — the user's own known_hosts files, `HostKeyAlias` and
 * `StrictHostKeyChecking` — so Console agrees with `ssh` about the host.
 */
function hostKeyTarget(
  sshHost: string,
  host: string,
  port: number,
  resolved: ResolvedSshConfig | undefined
): HostKeyTarget {
  if (!resolved) {
    return {
      sshHost,
      hostname: host,
      port,
      hostKeyAlias: undefined,
      userKnownHostsFiles: [
        join(homedir(), '.ssh', 'known_hosts'),
        join(homedir(), '.ssh', 'known_hosts2'),
      ],
      globalKnownHostsFiles: ['/etc/ssh/ssh_known_hosts', '/etc/ssh/ssh_known_hosts2'],
      strictHostKeyChecking: 'ask',
    };
  }
  return {
    sshHost,
    hostname: host,
    port,
    hostKeyAlias: resolved.hostKeyAlias,
    userKnownHostsFiles: resolved.userKnownHostsFiles.map(expandHome),
    globalKnownHostsFiles: resolved.globalKnownHostsFiles.map(expandHome),
    strictHostKeyChecking: resolved.strictHostKeyChecking,
  };
}

export async function resolveSshConnectConfig(
  input: SshConnectInput,
  checkHostKey: HostKeyChecker,
  depsOverride: Partial<SshConnectDeps> = {}
): Promise<SshConnectResult> {
  const deps = { ...defaultDeps(), ...depsOverride };
  const base = input.config;
  const alias = base.sshConfigAlias;
  const resolved = alias ? await deps.resolveSshConfig(alias) : undefined;

  const host = resolved?.hostname || base.host;
  const port = resolved?.port ?? base.port;
  const username = resolved?.user || base.username;
  const authResult = await buildAuthConfig(input, base, resolved, deps);
  const hostKeyCheck = await checkHostKey(hostKeyTarget(alias ?? base.host, host, port, resolved));

  const config: ConnectConfig = {
    host,
    port,
    username,
    readyTimeout: resolved?.connectTimeout !== undefined ? resolved.connectTimeout * 1000 : 20_000,
    // Default to a tight keepalive so a connection killed by laptop sleep or a
    // network change is detected in seconds (≈45s worst case at countMax 3),
    // rather than up to ~3min at the old 60s cadence, which left the live
    // terminal stream frozen until the probes finally timed out. An explicit
    // ssh-config ServerAliveInterval still wins.
    keepaliveInterval: resolved?.serverAliveInterval ? resolved.serverAliveInterval * 1000 : 15_000,
    keepaliveCountMax: resolved?.serverAliveCountMax ?? 3,
    ...authResult.config,
    hostVerifier: hostKeyCheck.hostVerifier,
    algorithms: { serverHostKey: hostKeyCheck.serverHostKeyAlgorithms },
  };

  // Only the host's own SSH config turns forwarding on: a connection with no
  // alias resolved never forwards the user's agent.
  applyForwardAgent(config, resolved?.forwardAgent === true, resolved, authResult, deps);

  let debugLogs: string[] = [];
  let cleanup = () => {};
  const tokens: ProxyTokens = { host, port, username, originalHost: alias ?? base.host };
  const proxyCommand = alias ? resolved?.proxyCommand : undefined;
  const proxyJump = resolved?.proxyJump ?? (!alias ? base.proxyJump : undefined);

  let transport: Omit<TransportResult, 'process'> | undefined;
  if (proxyCommand) {
    transport = deps.spawnProxyCommand(proxyCommand, tokens);
  } else if (proxyJump) {
    transport = deps.spawnProxyJump(proxyJump, host, port);
  }

  if (transport) {
    config.sock = transport.sock;
    cleanup = transport.cleanup;
    debugLogs = transport.debugLogs;
  }

  return { config, cleanup, debugLogs, hostKeyRejection: hostKeyCheck.rejection };
}

export function createSshConnectConfigResolver(deps: SshConnectDeps, checkHostKey: HostKeyChecker) {
  return async (input: SshConnectInput): Promise<SshConnectResult> =>
    await resolveSshConnectConfig(input, checkHostKey, deps);
}
