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
 * requests as; see `init-db` in `deploy/local/standalone-docker-compose.yml`.
 *
 * `secretKeys` is switch-core's `SECRET_KEYS`: what it signs sessions and
 * encrypts stored credentials with. `jwtSecretKey` is the key that did both
 * before it, still passed so the server can read what it wrote back then. */
export type LocalServerSecrets = {
  dbPassword: string;
  dbRuntimePassword: string;
  agentRegistrationToken: string;
  jwtSecretKey: string;
  secretKeys: string;
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
    secretKeys: `console:${randomBytes(32).toString('hex')}`,
    gatewayAdminPassword: token(),
    mattermostAdminPassword: token(),
    mattermostUserPassword: token(),
  };
}

/**
 * Fill in the secrets switch-core gained after a bundle was written, and only
 * those. Safe where regenerating the bundle is not:
 *
 * - `dbRuntimePassword`, from before the restricted runtime role: nothing on
 *   the existing volume used it, and `init-db` sets the role's password on
 *   every start.
 * - `secretKeys`, from before `SECRET_KEYS`: a server that never had one
 *   still reads what it stored through `jwtSecretKey`, and moves it onto the
 *   new key on its first start. Once a server has started with one it must
 *   never be replaced, which is why only an empty value is filled.
 */
export function withNewerSecrets(secrets: LocalServerSecrets): {
  secrets: LocalServerSecrets;
  migrated: boolean;
} {
  const missing: Partial<LocalServerSecrets> = {};
  if (!secrets.dbRuntimePassword) missing.dbRuntimePassword = generateSecrets().dbRuntimePassword;
  if (!secrets.secretKeys) missing.secretKeys = generateSecrets().secretKeys;
  if (Object.keys(missing).length === 0) return { secrets, migrated: false };
  return { secrets: { ...secrets, ...missing }, migrated: true };
}
