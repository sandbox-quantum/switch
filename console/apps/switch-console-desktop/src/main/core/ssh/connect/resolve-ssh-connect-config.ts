// Builds the ssh2 ConnectConfig for a remote agent. Ported from Switch Console and
// trimmed for Switch Console (CHOO-1059): connections are never persisted as rows,
// so this only handles the transient path, and a remote agent always carries an
// `~/.ssh/config` Host alias — the canonical OpenSSH resolution via `ssh -G` is
// the source of truth. The manual-agent (no-alias hostname lookup) and
// credential-service password paths from Switch Console are dropped.
import { readFile } from 'node:fs/promises';
import ssh2, { type BaseAgent, type ConnectConfig } from 'ssh2';
import type { SshConfig } from '@shared/core/ssh/ssh';
import {
  resolveSshConfig as defaultResolveSshConfig,
  type ResolvedSshConfig,
} from '../config/resolve-ssh-config';
import {
  spawnProxyCommand as defaultSpawnProxyCommand,
  spawnProxyJump as defaultSpawnProxyJump,
  type ProxyTokens,
  type TransportResult,
} from '../transport/transports';
import { splitKnownHostsFiles, type KnownHostsDeps } from './known-hosts';
import { buildAuthConfig } from './ssh-connect-auth';
import { applyForwardAgent } from './ssh-connect-forward-agent';
import { createHostVerifier, normalizeStrictHostKeyChecking } from './ssh-connect-host-key';

const { createAgent } = ssh2;

export interface SshConnectResult {
  config: ConnectConfig;
  cleanup: () => void;
  debugLogs: string[];
}

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
  knownHosts?: Partial<KnownHostsDeps>;
}

// What OpenSSH uses when no ssh-config alias resolved these for us.
const DEFAULT_USER_KNOWN_HOSTS_FILE = '~/.ssh/known_hosts';
const DEFAULT_GLOBAL_KNOWN_HOSTS_FILES = '/etc/ssh/ssh_known_hosts';

function defaultDeps(): SshConnectDeps {
  return {
    readFile,
    resolveSshConfig: (alias) => defaultResolveSshConfig(alias),
    spawnProxyCommand: (command, tokens) => defaultSpawnProxyCommand(command, tokens),
    spawnProxyJump: (jumpSpec, destHost, destPort) =>
      defaultSpawnProxyJump(jumpSpec, destHost, destPort),
    createAgent,
    env: process.env,
  };
}

function buildHostVerifier(
  host: string,
  port: number,
  resolved: ResolvedSshConfig | undefined,
  deps: SshConnectDeps,
  onDebug: (message: string) => void
) {
  const userFiles = splitKnownHostsFiles(
    resolved?.userKnownHostsFile ?? DEFAULT_USER_KNOWN_HOSTS_FILE
  );
  const globalFiles = splitKnownHostsFiles(
    resolved?.globalKnownHostsFile ?? DEFAULT_GLOBAL_KNOWN_HOSTS_FILES
  );

  return createHostVerifier(
    {
      host,
      port,
      knownHostsFiles: [...userFiles, ...globalFiles],
      // OpenSSH records a first-use key in the first user file only. With
      // `UserKnownHostsFile none` there is nowhere to record it, so the key is
      // checked but never pinned.
      writeToFile: userFiles[0],
      strictHostKeyChecking: normalizeStrictHostKeyChecking(resolved?.strictHostKeyChecking),
      hashKnownHosts: resolved?.hashKnownHosts === true,
      onDebug,
    },
    deps.knownHosts ?? {}
  );
}

export async function resolveSshConnectConfig(
  input: SshConnectInput,
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
  };

  const forwardAgent = resolved?.forwardAgent ?? base.forwardAgent === true;
  applyForwardAgent(config, forwardAgent, resolved, authResult, deps);

  let debugLogs: string[] = [];
  // ssh2 trusts any host key unless a hostVerifier says otherwise, so this is
  // what stops the Console handing credentials and a forwarded agent to whoever
  // answers the address. It reads the same known_hosts OpenSSH would.
  config.hostVerifier = buildHostVerifier(host, port, resolved, deps, (message) =>
    debugLogs.push(message)
  );

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

  return { config, cleanup, debugLogs };
}

export function createSshConnectConfigResolver(deps: SshConnectDeps) {
  return async (input: SshConnectInput): Promise<SshConnectResult> =>
    await resolveSshConnectConfig(input, deps);
}
