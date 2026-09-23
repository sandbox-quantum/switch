import { randomBytes } from 'node:crypto';

/** The randomly-generated secrets the local stack needs. These are the source of
 * truth (kept in the OS-encrypted app-secrets store); the on-disk `.env` docker
 * reads is derived from them at each start.
 *
 * `dbPassword` is the schema owner's password (`DB_OWNER_PASSWORD` in the
 * `.env`, `POSTGRES_PASSWORD` for the container) — kept under its original
 * field name because the Postgres volume on every existing install was
 * bootstrapped with it, and renaming the field here does not rename what is
 * already on disk. `dbRuntimePassword` is the separate, unprivileged runtime
 * role (`DB_PASSWORD`/`DB_USER=switch_app`) that switch-core actually serves
 * requests as; see `init-db` in `deploy/local/standalone-docker-compose.yml`. */
export type LocalServerSecrets = {
  dbPassword: string;
  dbRuntimePassword: string;
  agentRegistrationToken: string;
  jwtSecretKey: string;
  gatewayAdminPassword: string;
  mattermostAdminPassword: string;
  mattermostUserPassword: string;
};

function token(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

/** Generate a fresh, all-distinct secret bundle. Pure apart from CSPRNG input,
 * so it has no dependency on the Electron app or DB and is unit-testable. */
export function generateSecrets(): LocalServerSecrets {
  return {
    dbPassword: token(),
    dbRuntimePassword: token(),
    agentRegistrationToken: token(),
    jwtSecretKey: token(32),
    gatewayAdminPassword: token(),
    mattermostAdminPassword: token(),
    mattermostUserPassword: token(),
  };
}

/**
 * `dbRuntimePassword` did not exist before switch-core split its database
 * connection into an owner role and a restricted runtime role, so a bundle
 * stored before that split parses as `LocalServerSecrets` with that one field
 * missing — and a stack's `.env` written before that split names no runtime
 * role either (see `readStackEnv`). Filling it in is safe in a way regenerating the bundle is not:
 * nothing on the existing Postgres volume was ever created with it, since the
 * runtime role did not exist yet either. `init-db` creates that role and
 * `ALTER ROLE`s its password idempotently on every start (see
 * `deploy/local/standalone-docker-compose.yml`), so whatever value lands here
 * simply becomes the role's password on the next start, the same way a
 * freshly generated bundle's would.
 */
export function withRuntimePassword(secrets: LocalServerSecrets): {
  secrets: LocalServerSecrets;
  migrated: boolean;
} {
  if (secrets.dbRuntimePassword) return { secrets, migrated: false };
  return {
    secrets: { ...secrets, dbRuntimePassword: generateSecrets().dbRuntimePassword },
    migrated: true,
  };
}
