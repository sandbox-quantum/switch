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

/**
 * Where a browser sign-in on a machine stands: the machine is starting it;
 * its page is open to sign in on (with a code to type there, or waiting for
 * the code the page shows to be pasted back); or it ended.
 */
export type BrowserSignInState =
  | { state: 'starting' }
  | { state: 'open'; url: string; userCode: string | null; needsCode: boolean }
  | { state: 'succeeded' }
  | { state: 'failed'; message: string };

/** What an app does for a browser sign-in on a machine: start it, read it, send it the code. */
export type BrowserSignInHost = {
  /** Starts it; answers the operation the machine runs it as. */
  start: () => Promise<string>;
  read: (operationId: string) => Promise<BrowserSignInState>;
  sendCode: (operationId: string, code: string) => Promise<void>;
};
