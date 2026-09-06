import { randomBytes } from 'node:crypto';

/** The randomly-generated secrets the local stack needs. These are the source of
 * truth (kept in the OS-encrypted app-secrets store); the on-disk `.env` docker
 * reads is derived from them at each start. */
export type LocalServerSecrets = {
  dbPassword: string;
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
    agentRegistrationToken: token(),
    jwtSecretKey: token(32),
    gatewayAdminPassword: token(),
    mattermostAdminPassword: token(),
    mattermostUserPassword: token(),
  };
}
