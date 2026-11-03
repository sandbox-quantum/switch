import type { Environment } from './env.ts';

/**
 * The read-only guard. Against `prod` the clients refuse every request that
 * could change state, before it leaves the process, so a misconfigured base URL
 * is a failed test rather than an incident.
 *
 * Logging in is the one exemption: it is a `POST` but changes nothing the
 * product shows, and a read-only smoke still has to authenticate.
 */

export class ReadOnlyEnvironmentError extends Error {
  constructor(method: string, path: string, environment: Environment) {
    super(
      `Refusing ${method} ${path}: the target environment is '${environment}', which is ` +
        `read-only for the harness. Only GET requests and logging in are allowed there.`
    );
    this.name = 'ReadOnlyEnvironmentError';
  }
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Paths that are writes by method but not by effect. */
const LOGIN_PATHS = new Set(['/gateway/auth/login', '/api/v4/users/login']);

export function isReadOnly(environment: Environment): boolean {
  return environment === 'prod';
}

/** Throw {@link ReadOnlyEnvironmentError} when `method path` is a write against a read-only environment. */
export function assertAllowed(environment: Environment, method: string, path: string): void {
  if (!isReadOnly(environment)) return;
  const upper = method.toUpperCase();
  if (READ_METHODS.has(upper)) return;
  const bare = path.split('?', 1)[0] ?? path;
  if (upper === 'POST' && LOGIN_PATHS.has(bare)) return;
  throw new ReadOnlyEnvironmentError(upper, bare, environment);
}
