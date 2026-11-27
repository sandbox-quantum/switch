/**
 * A provider login to give a machine: a key or token typed in (or a sign-in
 * file picked, `auth-json`), this
 * computer's own sign-in for the provider, read from its file, or (Claude
 * and Antigravity) Google Vertex AI, with a service account key pasted or picked, or this
 * computer's Google application-default sign-in.
 */
export type MachineLoginInput =
  | { source: 'typed'; kind: 'api-key' | 'setup-token' | 'auth-json'; credential: string }
  | { source: 'this-computer' }
  | {
      source: 'vertex';
      project: string;
      region: string;
      credentials: { from: 'key'; json: string } | { from: 'this-computer' };
    };
