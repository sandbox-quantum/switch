import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { Duplex, type Readable, type Writable } from 'node:stream';

type SshChild = ChildProcessByStdio<Writable, Readable, Readable>;

export interface ProxyTokens {
  host: string;
  port: number;
  username: string;
  originalHost?: string;
}

export interface TransportResult {
  sock: Duplex;
  cleanup: () => void;
  process: SshChild;
  debugLogs: string[];
}

export type SpawnProcess = (
  command: string,
  args: string[],
  options: { shell?: boolean; stdio: ['pipe', 'pipe', 'pipe'] }
) => SshChild;

type TerminableProcess = {
  exitCode: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
};

type TimerApi = {
  setTimeout(callback: () => void, ms: number): { unref?: () => void };
};

const DEFAULT_SSH_ARGS = [
  '-o',
  'BatchMode=yes',
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=none',
];

const SAFE_HOSTNAME = /^[a-zA-Z0-9._\-[\]:]+$/;
const SAFE_USERNAME = /^[a-zA-Z0-9._\-@]+$/;
const SAFE_SSH_ALIAS = /^[A-Za-z0-9._@%+:/[\]-]+$/;
const MAX_DEBUG_LOG_LINES = 64;

function hasExited(child: TerminableProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export function terminateProxyChild(
  child: TerminableProcess,
  timerApi: TimerApi = { setTimeout }
): void {
  if (hasExited(child)) return;
  child.kill('SIGTERM');
  const timer = timerApi.setTimeout(() => {
    if (!hasExited(child)) child.kill('SIGKILL');
  }, 3_000);
  timer.unref?.();
}

export function childToDuplex(child: SshChild): Duplex {
  const duplex = new Duplex({
    allowHalfOpen: true,
    read() {
      child.stdout.resume();
    },
    write(chunk: Buffer, _encoding, callback) {
      child.stdin.write(chunk, (error) => callback(error ?? undefined));
    },
    final(callback) {
      child.stdin.end(callback);
    },
    destroy(error, callback) {
      terminateProxyChild(child);
      callback(error);
    },
  });

  child.stdout.on('data', (chunk: Buffer) => {
    if (!duplex.push(chunk)) child.stdout.pause();
  });
  child.stdout.once('end', () => duplex.push(null));
  child.stdout.once('error', (error) => duplex.destroy(error));
  child.stdin.once('error', (error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
      duplex.destroy(error);
    }
  });
  child.once('error', (error) => duplex.destroy(error));
  child.once('close', (code, signal) => {
    if (duplex.destroyed) return;
    // A clean exit still ends the transport. Left alone, the pipe stayed
    // half-open — read side ended, never destroyed — so ssh2 refused every
    // channel with "Not connected" and never emitted `close` (an IAP tunnel
    // on dev-vm, 2026-09-30, for hours).
    if (code === 0) {
      duplex.destroy();
      return;
    }
    const reason = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
    duplex.destroy(new Error(`Proxy process exited with ${reason}`));
  });

  return duplex;
}

type JumpHop = { user?: string; host: string; port?: number };

const UNSAFE_HOP_CHARS = /[\s\x00-\x1f\x7f]/;
const PORT_DIGITS = /^\d+$/;
const SSH_URI_PREFIX = 'ssh://';
// A destination is one argv element of `-W`, so a scoped IPv6 address
// (`fe80::1%en0`) may keep its `%`.
const SAFE_DESTINATION_HOST = /^[a-zA-Z0-9._\-[\]:%]+$/;

function parsePort(raw: string, hop: string): number {
  const port = PORT_DIGITS.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid ProxyJump port: ${hop}`);
  }
  return port;
}

// Every hop is checked in full, and the hops passed on to `ssh -J` are rebuilt
// from the checked parts rather than forwarded as written, so nothing the
// parser skipped over (a trailing `22 -oProxyCommand=…` after a port, say)
// reaches ssh.
function parseJumpHop(hop: string): JumpHop {
  if (!hop || UNSAFE_HOP_CHARS.test(hop) || hop.startsWith('-')) {
    throw new Error(`Invalid ProxyJump host: ${JSON.stringify(hop)}`);
  }

  let rest = hop.startsWith(SSH_URI_PREFIX) ? hop.slice(SSH_URI_PREFIX.length) : hop;
  let user: string | undefined;
  const atIndex = rest.lastIndexOf('@');
  if (atIndex !== -1) {
    user = rest.slice(0, atIndex);
    rest = rest.slice(atIndex + 1);
    if (!user || user.startsWith('-') || !SAFE_USERNAME.test(user)) {
      throw new Error(`Invalid ProxyJump user: ${hop}`);
    }
  }

  let host: string;
  let port: number | undefined;
  if (rest.startsWith('[')) {
    const bracketEnd = rest.indexOf(']');
    if (bracketEnd === -1) throw new Error(`Invalid ProxyJump host: ${hop}`);
    host = rest.slice(0, bracketEnd + 1);
    const suffix = rest.slice(bracketEnd + 1);
    if (suffix) {
      if (!suffix.startsWith(':')) throw new Error(`Invalid ProxyJump host: ${hop}`);
      port = parsePort(suffix.slice(1), hop);
    }
  } else {
    const colonIndex = rest.indexOf(':');
    if (colonIndex === -1) {
      host = rest;
    } else {
      host = rest.slice(0, colonIndex);
      port = parsePort(rest.slice(colonIndex + 1), hop);
    }
    if (host.includes('[') || host.includes(']')) {
      throw new Error(`Invalid ProxyJump host: ${hop}`);
    }
  }

  if (!host || host.startsWith('-') || !SAFE_SSH_ALIAS.test(host)) {
    throw new Error(`Invalid ProxyJump host: ${hop}`);
  }
  return { user, host, port };
}

function formatJumpHop(hop: JumpHop): string {
  const userPart = hop.user ? `${hop.user}@` : '';
  const portPart = hop.port !== undefined ? `:${hop.port}` : '';
  return `${userPart}${hop.host}${portPart}`;
}

export function buildProxyJumpArgs(jumpSpec: string, destHost: string, destPort: number): string[] {
  if (!jumpSpec.trim()) {
    throw new Error('ProxyJump is empty');
  }
  const hops = jumpSpec.split(',').map((hop) => parseJumpHop(hop.trim()));
  if (!destHost || destHost.startsWith('-') || !SAFE_DESTINATION_HOST.test(destHost)) {
    throw new Error(`Invalid ProxyJump destination host: ${destHost}`);
  }
  if (!Number.isInteger(destPort) || destPort <= 0 || destPort > 65_535) {
    throw new Error(`Invalid ProxyJump destination port: ${destPort}`);
  }

  const precedingHops = hops.slice(0, -1);
  const last = hops[hops.length - 1]!;
  const args = [...DEFAULT_SSH_ARGS];

  if (precedingHops.length > 0) {
    args.push('-J', precedingHops.map(formatJumpHop).join(','));
  }
  if (last.port !== undefined) {
    args.push('-p', String(last.port));
  }
  const bracketed =
    destHost.includes(':') && !destHost.startsWith('[') ? `[${destHost}]` : destHost;
  args.push('-W', `${bracketed}:${destPort}`);
  args.push(last.user ? `${last.user}@${last.host}` : last.host);
  return args;
}

export function expandProxyCommandTokens(command: string, tokens: ProxyTokens): string {
  if (!SAFE_HOSTNAME.test(tokens.host)) {
    throw new Error(`Resolved hostname contains unsafe characters: ${tokens.host}`);
  }
  if (!SAFE_USERNAME.test(tokens.username)) {
    throw new Error(`Resolved username contains unsafe characters: ${tokens.username}`);
  }
  if (!Number.isInteger(tokens.port) || tokens.port <= 0) {
    throw new Error(`Resolved port is invalid: ${tokens.port}`);
  }
  if (
    tokens.originalHost !== undefined &&
    (tokens.originalHost.startsWith('-') || !SAFE_SSH_ALIAS.test(tokens.originalHost))
  ) {
    throw new Error(`Original host contains unsafe characters: ${tokens.originalHost}`);
  }

  return command
    .replace(/%%/g, '\0')
    .replace(/%([A-Za-z])/g, (_match, token: string) => {
      switch (token) {
        case 'h':
          return tokens.host;
        case 'p':
          return String(tokens.port);
        case 'r':
          return tokens.username;
        case 'n':
          return tokens.originalHost ?? tokens.host;
        default:
          return '';
      }
    })
    .replace(/\0/g, '%');
}

function createTransport(child: SshChild): TransportResult {
  const debugLogs: string[] = [];
  const sock = childToDuplex(child);
  let cleanedUp = false;

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    const lines = chunk
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    debugLogs.push(...lines);
    if (debugLogs.length > MAX_DEBUG_LOG_LINES) {
      debugLogs.splice(0, debugLogs.length - MAX_DEBUG_LOG_LINES);
    }
  });

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    sock.destroy();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    terminateProxyChild(child);
  };

  return { sock, cleanup, process: child, debugLogs };
}

export function spawnProxyJump(
  jumpSpec: string,
  destHost: string,
  destPort: number,
  spawnProcess: SpawnProcess = spawn as SpawnProcess
): TransportResult {
  const args = buildProxyJumpArgs(jumpSpec, destHost, destPort);
  return createTransport(spawnProcess('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] }));
}

export function spawnProxyCommand(
  command: string,
  tokens: ProxyTokens,
  spawnProcess: SpawnProcess = spawn as SpawnProcess
): TransportResult {
  return spawnProxyCommandWithShell(command, tokens, spawnProcess);
}

export function spawnProxyCommandWithShell(
  command: string,
  tokens: ProxyTokens,
  spawnProcess: SpawnProcess = spawn as SpawnProcess
): TransportResult {
  const expanded = expandProxyCommandTokens(command, tokens);
  return createTransport(
    spawnProcess(expanded, [], { shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
  );
}
