import { z } from 'zod';

/**
 * A login through Google Vertex AI: the Google Cloud project and region the
 * provider calls Vertex in, and the Google credential it signs in with. It is
 * the `credential` of a provider login of kind `vertex`, as JSON. Claude Code
 * and Google's Antigravity CLI (`agy`) sign in with one.
 *
 * The credential is a service account key, or a user's own sign-in as
 * `gcloud auth application-default login` writes it (`authorized_user`).
 * Other Google credential types are refused: workload identity federation
 * (`external_account`) and impersonation name files, commands or a source
 * credential on the computer that made them, which the machine does not have.
 */
const nonEmpty = z.string().trim().min(1);

/** The providers a `vertex` login signs in. */
export const VERTEX_PROVIDERS = ['claude', 'antigravity'] as const;
export type VertexProvider = (typeof VERTEX_PROVIDERS)[number];

/** Why a `vertex` login was refused for any other provider. */
export const VERTEX_PROVIDERS_ONLY = 'Only Claude and Antigravity sign in through Vertex AI.';

/** Whether `provider` can sign in with a `vertex` login. */
export function signsInThroughVertex(provider: string): provider is VertexProvider {
  return (VERTEX_PROVIDERS as readonly string[]).includes(provider);
}

const authorizedUserSchema = z.looseObject({
  type: z.literal('authorized_user'),
  client_id: nonEmpty,
  client_secret: nonEmpty,
  refresh_token: nonEmpty,
});

const serviceAccountSchema = z.looseObject({
  type: z.literal('service_account'),
  client_email: z.email(),
  private_key: z.string().includes('PRIVATE KEY'),
  private_key_id: nonEmpty.optional(),
  token_uri: z.url({ protocol: /^https$/ }).optional(),
});

export const googleCredentialsSchema = z.discriminatedUnion('type', [
  authorizedUserSchema,
  serviceAccountSchema,
]);
export type GoogleCredentials = z.infer<typeof googleCredentialsSchema>;

/** A Google Cloud project id: 6 to 30 lowercase letters, digits and hyphens, starting with a letter. */
export const VERTEX_PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export const VERTEX_REGION_PATTERN = /^[a-z0-9-]{1,64}$/;

export const vertexLoginSchema = z.strictObject({
  v: z.literal(1),
  project: z.string().regex(VERTEX_PROJECT_PATTERN),
  region: z.string().regex(VERTEX_REGION_PATTERN),
  credentials: googleCredentialsSchema,
});
export type VertexLogin = z.infer<typeof vertexLoginSchema>;

/** Where a Vertex login's Google credential is written, under the agent host's state root. */
export const VERTEX_CREDENTIALS_FILE = 'provider-home/google-credentials.json';

/**
 * The Google credential JSON `text` names, checked: a service account key or a
 * user's application-default sign-in. Throws, saying what is wrong, for
 * anything else.
 */
export function parseGoogleCredentials(text: string): GoogleCredentials {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('The Google credential is not JSON.');
  }
  return googleCredentials(value);
}

function googleCredentials(value: unknown): GoogleCredentials {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('The Google credential is not a JSON object.');
  const type = (value as { type?: unknown }).type;
  if (type !== 'service_account' && type !== 'authorized_user')
    throw new Error(
      `Only a service account key or a Google sign-in from \`gcloud auth application-default login\` can be given, not ${typeof type === 'string' ? `a credential of type '${type}'` : 'this credential'}.`
    );
  const parsed = googleCredentialsSchema.safeParse(value);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(
      `The ${type === 'service_account' ? 'service account key' : 'Google sign-in'} is missing or has an invalid ${fields.join(', ')}.`
    );
  }
  return parsed.data;
}

/** The credential of a `vertex` login, checked; throws, saying what is wrong. */
export function vertexLoginCredential(input: {
  project: string;
  region: string;
  credentials: GoogleCredentials;
}): string {
  const project = input.project.trim();
  const region = input.region.trim();
  if (!VERTEX_PROJECT_PATTERN.test(project))
    throw new Error(
      `'${project}' is not a Google Cloud project id: 6 to 30 lowercase letters, digits and hyphens, starting with a letter.`
    );
  if (!VERTEX_REGION_PATTERN.test(region))
    throw new Error(`'${region}' is not a Vertex AI region, such as global or us-east5.`);
  return JSON.stringify({
    v: 1,
    project,
    region,
    credentials: googleCredentials(input.credentials),
  } satisfies VertexLogin);
}

/** A `vertex` login's credential, parsed; throws, saying what is wrong. */
export function parseVertexLogin(credential: string): VertexLogin {
  let value: unknown;
  try {
    value = JSON.parse(credential);
  } catch {
    throw new Error('The Vertex AI login is not JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('The Vertex AI login is not a JSON object.');
  const { credentials, ...rest } = value as Record<string, unknown>;
  const outer = vertexLoginSchema.omit({ credentials: true }).safeParse(rest);
  if (!outer.success)
    throw new Error(
      `The Vertex AI login has an invalid ${[...new Set(outer.error.issues.map((issue) => issue.path.join('.') || 'field'))].join(', ')}.`
    );
  return { ...outer.data, credentials: googleCredentials(credentials) };
}

/**
 * The variables `provider` signs in to Vertex AI with: `login`'s project and
 * region, and the Google credential written at `credentialsPath`. Claude Code
 * reads its own; Antigravity's `agy` signs in with application-default
 * credentials when `AGY_ADC_AUTH` is set, and bills the quota project.
 */
export function vertexEnvironment(
  provider: VertexProvider,
  login: VertexLogin,
  credentialsPath: string
): Record<string, string> {
  switch (provider) {
    case 'claude':
      return {
        CLAUDE_CODE_USE_VERTEX: '1',
        ANTHROPIC_VERTEX_PROJECT_ID: login.project,
        CLOUD_ML_REGION: login.region,
        GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
      };
    case 'antigravity':
      return {
        AGY_ADC_AUTH: 'true',
        GOOGLE_CLOUD_PROJECT: login.project,
        GOOGLE_CLOUD_QUOTA_PROJECT: login.project,
        GOOGLE_CLOUD_LOCATION: login.region,
        GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
      };
  }
}

/** Every variable `vertexEnvironment` sets for `provider`. */
export const VERTEX_VARIABLES: Record<VertexProvider, readonly string[]> = {
  claude: [
    'CLAUDE_CODE_USE_VERTEX',
    'ANTHROPIC_VERTEX_PROJECT_ID',
    'CLOUD_ML_REGION',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ],
  antigravity: [
    'AGY_ADC_AUTH',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_QUOTA_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ],
};
