/**
 * A Claude login through Google Vertex AI, as a machine takes it: the
 * credential of a provider login of kind `vertex`, the JSON
 * `@switch-console/agent-providers`' `vertexLoginCredential` makes in
 * Console, checked here before it is sealed so a mistake is said at once
 * rather than by the machine.
 */

/** A Google Cloud project id: 6 to 30 lowercase letters, digits and hyphens, starting with a letter. */
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{1,64}$/;

/** Claude on Vertex AI is served from the global endpoint unless the project pins a region. */
export const VERTEX_DEFAULT_REGION = 'global';

const REQUIRED: Record<string, readonly string[]> = {
  service_account: ['client_email', 'private_key'],
  authorized_user: ['client_id', 'client_secret', 'refresh_token'],
};

/** The credential of a `vertex` login; throws, saying what is wrong. */
export function vertexLoginCredential(input: {
  project: string;
  region: string;
  /** A service account key, or the sign-in `gcloud auth application-default login` writes, as JSON. */
  googleCredentials: string;
}): string {
  const project = input.project.trim();
  const region = input.region.trim();
  if (!PROJECT.test(project))
    throw new Error(
      `'${project}' is not a Google Cloud project id: 6 to 30 lowercase letters, digits and hyphens, starting with a letter.`
    );
  if (!REGION.test(region))
    throw new Error(`'${region}' is not a Vertex AI region, such as global or us-east5.`);
  let credentials: unknown;
  try {
    credentials = JSON.parse(input.googleCredentials);
  } catch {
    throw new Error('The Google credential is not JSON.');
  }
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials))
    throw new Error('The Google credential is not a JSON object.');
  const fields = credentials as Record<string, unknown>;
  const type = typeof fields.type === 'string' ? fields.type : null;
  const required = type ? REQUIRED[type] : undefined;
  if (!required)
    throw new Error(
      'Only a service account key or a Google sign-in from `gcloud auth application-default login` can be given.'
    );
  const missing = required.filter(
    (field) => typeof fields[field] !== 'string' || (fields[field] as string).trim() === ''
  );
  if (missing.length)
    throw new Error(
      `The ${type === 'service_account' ? 'service account key' : 'Google sign-in'} is missing ${missing.join(', ')}.`
    );
  return JSON.stringify({ v: 1, project, region, credentials });
}
