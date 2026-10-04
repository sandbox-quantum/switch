import { accessSync, constants, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeServerUrl } from './api';
import { ConfigurationError } from './errors';
import { errorMessage } from './log';
import type { ControllerStore } from './store';

/**
 * What a parent process hands a controller it starts, for one that was
 * enrolled by someone else (Switch Console enrolls through its signed-in
 * session): the identity on the command line, the credential on stdin, and
 * where the shared-host bundle is when the controller is not run from the
 * workspace.
 */

export const SHARED_HOST_BUNDLE_ENV = 'SWITCH_CONTROLLER_SHARED_HOST_BUNDLE';

/** How long `--credential-stdin` waits for the parent to write and close stdin. */
export const CREDENTIAL_STDIN_TIMEOUT_MS = 10_000;

type CredentialSource = AsyncIterable<Buffer | string> & { isTTY?: boolean };

/**
 * The controller credential, read from `input` to its end. The parent writes
 * it and closes the pipe; nothing about it touches the disk or the
 * environment, so the watchers and sessions this controller starts never
 * inherit it.
 *
 * Every way this fails (a terminal, a pipe that closes empty or never
 * closes, more than one token, a pipe that cannot be read) is a
 * `ConfigurationError`: starting again the same way would fail the same way.
 */
export async function readCredential(input: CredentialSource, timeoutMs: number): Promise<string> {
  if (input.isTTY)
    throw new ConfigurationError(
      '--credential-stdin reads the credential from a pipe that the parent process writes and closes; stdin is a terminal.'
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ConfigurationError(
            `No credential arrived on stdin within ${timeoutMs / 1000} s: the parent process must write it and close the pipe.`
          )
        ),
      timeoutMs
    );
  });
  const read = (async () => {
    let text = '';
    try {
      for await (const chunk of input) text += typeof chunk === 'string' ? chunk : chunk.toString();
    } catch (error) {
      throw new ConfigurationError(
        `The credential could not be read from stdin: ${errorMessage(error)}`
      );
    }
    return text;
  })();
  try {
    const credential = (await Promise.race([read, timeout])).trim();
    if (!credential) throw new ConfigurationError('stdin closed without a credential.');
    if (/\s/.test(credential))
      throw new ConfigurationError('The credential read from stdin is not one token.');
    return credential;
  } finally {
    clearTimeout(timer);
  }
}

export type Adoption = 'adopted' | 'unchanged' | 'server_changed';

/**
 * Seeds the store with an identity enrolled elsewhere, so `run` can start
 * without `enroll`. A store that already holds this identity is left as it
 * is. One that holds this controller at another server URL is moved to the
 * new one: the parent that enrolled it says where its server is now (its
 * address changed), and the cached assignment and cursors still belong to
 * this controller. One that holds another controller is refused, as `enroll`
 * refuses it, because its cached state belongs to that other controller.
 */
export function adoptIdentity(
  store: ControllerStore,
  input: { controllerId: string; server: string; name: string; now: Date },
  dataDir: string
): Adoption {
  const server = normalizeServerUrl(input.server);
  const existing = store.identity();
  if (existing) {
    if (existing.controllerId !== input.controllerId)
      throw new ConfigurationError(
        `${dataDir} already belongs to controller ${existing.controllerId} on ${existing.server}, not ${input.controllerId}. Use another --data-dir, or remove that directory first.`
      );
    if (existing.server === server) return 'unchanged';
    store.saveServer(server);
    return 'server_changed';
  }
  store.saveIdentity({
    controllerId: input.controllerId,
    server,
    name: input.name,
    enrolledAt: input.now.toISOString(),
  });
  return 'adopted';
}

/**
 * The agent-providers shared-host bundle the controller runs its agents with:
 * `--shared-host-bundle`, then `SWITCH_CONTROLLER_SHARED_HOST_BUNDLE`, then the
 * one built in the workspace. A packaged parent names its own copy, since a
 * bundled controller has no workspace to resolve it from.
 */
export function resolveSharedHostBundle(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  workspaceDefault: () => string
): string {
  const named = flag ?? env[SHARED_HOST_BUNDLE_ENV];
  if (named) return readableBundle(resolve(named), `The shared host bundle ${resolve(named)}`);
  let path: string;
  try {
    path = workspaceDefault();
  } catch (error) {
    throw new ConfigurationError(
      `No shared host bundle was named, and none could be found in the workspace: ${errorMessage(error)} Name one with --shared-host-bundle.`
    );
  }
  return readableBundle(
    path,
    `The shared host bundle at ${path}`,
    " Build the workspace packages first (pnpm -r --filter './packages/**' run build), or name one with --shared-host-bundle."
  );
}

/** `path`, once it is a file this process can read; a `ConfigurationError` otherwise. */
function readableBundle(path: string, what: string, hint = ''): string {
  let isFile: boolean;
  try {
    isFile = statSync(path).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new ConfigurationError(`${what} does not exist.${hint}`);
    throw new ConfigurationError(`${what} cannot be read: ${errorMessage(error)}`);
  }
  if (!isFile) throw new ConfigurationError(`${what} is not a file.${hint}`);
  try {
    accessSync(path, constants.R_OK);
  } catch (error) {
    throw new ConfigurationError(`${what} cannot be read: ${errorMessage(error)}`);
  }
  return path;
}

/** The bundle as built in the workspace, resolved through the package's exports. */
export function workspaceSharedHostBundle(): string {
  return fileURLToPath(import.meta.resolve('@switch-console/agent-providers/shared-host-daemon'));
}
