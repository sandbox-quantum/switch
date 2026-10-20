/** Google credentials shaped as real ones are, holding nothing that signs in. */
export const SERVICE_ACCOUNT_KEY_FIXTURE = {
  type: 'service_account',
  project_id: 'cg-vertexai',
  private_key_id: 'fixture-key-id',
  private_key: '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n',
  client_email: 'claude-vertex@cg-vertexai.iam.gserviceaccount.com',
  client_id: '1234567890',
  token_uri: 'https://oauth2.googleapis.com/token',
  universe_domain: 'googleapis.com',
} as const;

export const AUTHORIZED_USER_FIXTURE = {
  type: 'authorized_user',
  client_id: 'fixture.apps.googleusercontent.com',
  client_secret: 'fixture-secret',
  refresh_token: 'fixture-refresh',
  account: '',
  universe_domain: 'googleapis.com',
} as const;

/** A `vertex` login's credential for project `cg-vertexai` in `global`. */
export function vertexCredentialFixture(credentials: object = SERVICE_ACCOUNT_KEY_FIXTURE): string {
  return JSON.stringify({ v: 1, project: 'cg-vertexai', region: 'global', credentials });
}
