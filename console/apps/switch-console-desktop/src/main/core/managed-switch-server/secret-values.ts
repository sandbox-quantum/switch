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
