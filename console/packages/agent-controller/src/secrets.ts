import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** The one secret v1 keeps: the long-lived controller credential (`swcc_…`). */
export const CONTROLLER_CREDENTIAL = 'controller-credential';

/**
 * Where the controller keeps secrets: a file backend for a controller run on
 * its own, and a memory backend for one whose parent process holds the
 * credential and hands it over at start. An OS keychain backend slots in
 * behind the same interface.
 */
export interface SecretStore {
  /** Names the backend in logs and `status`. */
  readonly description: string;
  /** Logged once when the controller starts, for a backend with a caveat worth stating. */
  startupWarning(): string | null;
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

const NAME = /^[a-z0-9-]+$/;

/**
 * One file per secret under `dir`, owner-only (0600) in an owner-only
 * directory. The values are plaintext on disk; anyone who can read the
 * controller user's files can read them.
 */
export class FileSecretStore implements SecretStore {
  readonly description: string;

  constructor(private readonly dir: string) {
    this.description = `plaintext files in ${dir} (mode 0600)`;
  }

  startupWarning(): string {
    return `No OS keychain backend is in use: the controller credential is stored as a plaintext file in ${this.dir}, readable by this user only.`;
  }

  async get(name: string): Promise<string | null> {
    const path = this.path(name);
    let value: string;
    try {
      value = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (process.platform !== 'win32') {
      const mode = (await stat(path)).mode & 0o777;
      if (mode & 0o077)
        throw new Error(
          `The secret file ${path} is readable by other users (mode ${mode.toString(8)}). Treat the credential as exposed: revoke this controller and enroll again, or run chmod 600 on it if you are sure it was not read.`
        );
    }
    return value.trim();
  }

  async set(name: string, value: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(this.dir, 0o700);
    const path = this.path(name);
    const temporary = `${path}.${randomUUID()}`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  }

  async delete(name: string): Promise<void> {
    await unlink(this.path(name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  private path(name: string): string {
    if (!NAME.test(name)) throw new Error(`Invalid secret name '${name}'.`);
    return join(this.dir, name);
  }
}

/**
 * Secrets held only in this process's memory, for a controller started by a
 * process that keeps the credential in a store of its own (Switch Console,
 * which encrypts it with the OS keychain) and hands it over on stdin. Nothing
 * is written to disk: `set` and `delete` change what this process holds, and
 * the parent is told of a revocation by the exit code.
 */
export class MemorySecretStore implements SecretStore {
  readonly description: string;
  private readonly values: Map<string, string>;

  constructor(values: Record<string, string>, source: string) {
    this.values = new Map(Object.entries(values));
    for (const name of this.values.keys())
      if (!NAME.test(name)) throw new Error(`Invalid secret name '${name}'.`);
    this.description = `memory only (${source})`;
  }

  startupWarning(): null {
    return null;
  }

  async get(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }

  async set(name: string, value: string): Promise<void> {
    if (!NAME.test(name)) throw new Error(`Invalid secret name '${name}'.`);
    this.values.set(name, value);
  }

  async delete(name: string): Promise<void> {
    this.values.delete(name);
  }
}

/** Where `enroll` keeps the controller credential; recorded in the store so `run` reads it there. */
export const SECRET_STORE_KINDS = ['file', 'keychain', 'secret-service'] as const;
export type SecretStoreKind = (typeof SECRET_STORE_KINDS)[number];

export function isSecretStoreKind(value: string): value is SecretStoreKind {
  return (SECRET_STORE_KINDS as readonly string[]).includes(value);
}

/**
 * Runs a command with `input` on stdin; rejects with a {@link CommandFailure}
 * when it exits non-zero.
 */
export type CommandRunner = (
  file: string,
  args: string[],
  input: string | null
) => Promise<{ stdout: string }>;

export const runCommand: CommandRunner = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new CommandFailure(file, args, error.code, stderr.trim(), error.message));
        return;
      }
      resolve({ stdout });
    });
    child.stdin?.end(input ?? '');
  });

/** A command that exited non-zero, or could not be run (`code` is then a string such as `ENOENT`). */
export class CommandFailure extends Error {
  constructor(
    file: string,
    args: string[],
    readonly code: number | string | null | undefined,
    readonly stderr: string,
    detail: string
  ) {
    super(`${file} ${args[0] ?? ''} failed: ${stderr || detail}`);
    this.name = 'CommandFailure';
  }
}

const SERVICE = 'switch-agent-controller';

/** One keychain entry per secret and data directory, so two controllers on one account do not share. */
function account(dataDir: string, name: string): string {
  if (!NAME.test(name)) throw new Error(`Invalid secret name '${name}'.`);
  return `${name}@${dataDir}`;
}

/**
 * The macOS login keychain, through `security`. The value is written through
 * `security -i` on stdin, never on the command line, where other processes
 * could read it.
 */
export class KeychainSecretStore implements SecretStore {
  readonly description = 'the macOS login keychain';

  constructor(
    private readonly dataDir: string,
    private readonly run: CommandRunner
  ) {}

  startupWarning(): null {
    return null;
  }

  async get(name: string): Promise<string | null> {
    try {
      const { stdout } = await this.run(
        'security',
        ['find-generic-password', '-s', SERVICE, '-a', account(this.dataDir, name), '-w'],
        null
      );
      return stdout.trim();
    } catch (error) {
      // 44: errSecItemNotFound.
      if (error instanceof CommandFailure && error.code === 44) return null;
      throw error;
    }
  }

  async set(name: string, value: string): Promise<void> {
    if (/["\\\n]/.test(value)) throw new Error('This secret cannot be stored in the keychain.');
    const command = `add-generic-password -U -s ${SERVICE} -a "${account(this.dataDir, name)}" -w "${value}"\n`;
    await this.run('security', ['-i'], command);
  }

  async delete(name: string): Promise<void> {
    try {
      await this.run(
        'security',
        ['delete-generic-password', '-s', SERVICE, '-a', account(this.dataDir, name)],
        null
      );
    } catch (error) {
      if (!(error instanceof CommandFailure && error.code === 44)) throw error;
    }
  }
}

/**
 * The desktop keyring on Linux (GNOME Keyring, KWallet) through libsecret's
 * `secret-tool`, which reads the value from stdin. It needs a session bus and
 * an unlocked keyring, which a service started at boot usually lacks; that is
 * why it is chosen only when asked for.
 */
export class SecretServiceStore implements SecretStore {
  readonly description = 'the desktop keyring (Secret Service)';

  constructor(
    private readonly dataDir: string,
    private readonly run: CommandRunner
  ) {}

  startupWarning(): null {
    return null;
  }

  async get(name: string): Promise<string | null> {
    const attributes = ['service', SERVICE, 'account', account(this.dataDir, name)];
    try {
      const { stdout } = await this.run('secret-tool', ['lookup', ...attributes], null);
      return stdout.trim() || null;
    } catch (error) {
      // `lookup` exits 1, saying nothing, when there is no such secret.
      if (error instanceof CommandFailure && error.code === 1 && error.stderr === '') return null;
      throw error;
    }
  }

  async set(name: string, value: string): Promise<void> {
    await this.run(
      'secret-tool',
      [
        'store',
        '--label',
        'Switch agents controller',
        'service',
        SERVICE,
        'account',
        account(this.dataDir, name),
      ],
      value
    );
  }

  async delete(name: string): Promise<void> {
    await this.run(
      'secret-tool',
      ['clear', 'service', SERVICE, 'account', account(this.dataDir, name)],
      null
    );
  }
}

/**
 * The store a data directory's credential lives in. `dir` is the file
 * backend's directory; `dataDir` keys keychain entries.
 */
export function secretStoreFor(
  kind: SecretStoreKind,
  paths: { dir: string; dataDir: string },
  run: CommandRunner
): SecretStore {
  switch (kind) {
    case 'file':
      return new FileSecretStore(paths.dir);
    case 'keychain':
      return new KeychainSecretStore(paths.dataDir, run);
    case 'secret-service':
      return new SecretServiceStore(paths.dataDir, run);
  }
}

/**
 * What `enroll` uses when not told: the macOS keychain on a Mac, where the
 * service runs in the user's session and can read it; files elsewhere, since
 * a Linux service usually starts with no keyring to unlock.
 */
export function defaultSecretStoreKind(platform: NodeJS.Platform): SecretStoreKind {
  return platform === 'darwin' ? 'keychain' : 'file';
}
