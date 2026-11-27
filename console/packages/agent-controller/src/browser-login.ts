import { type SealingKeyPair, sealProviderLogin } from '@switch-console/agent-providers';
import {
  type BrowserSignInProvider,
  type SignInPage,
  startBrowserSignIn,
} from '@switch-console/plugins/browser-sign-in';
import { ControllerApiError, type ControllerClient, isRevoked } from './api';
import { errorMessage, type Logger } from './log';
import type { OperationProgress, OperationResult, ProviderStatus } from './schemas';

/** How long a person has to finish a browser sign-in. */
export const BROWSER_SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** How often the sign-in reports to Switch, renewing its lease and asking for a code sent. */
export const BROWSER_SIGN_IN_PROGRESS_MS = 2_000;

export type BrowserLoginDeps = {
  client: Pick<ControllerClient, 'operationProgress' | 'keepBrowserLogin'>;
  /** This machine's sealing keys; null for a controller that keeps none across starts. */
  keys: SealingKeyPair | null;
  controllerId: string;
  binaryPath: (provider: BrowserSignInProvider) => Promise<string | null>;
  /** Takes up the login given to the machine for the provider now, as a `sealed` one is. */
  takeUpLogin: (
    provider: BrowserSignInProvider
  ) => Promise<{ status: ProviderStatus; problem: { code: string; message: string } | null }>;
  signal: AbortSignal;
  timeoutMs: number;
  progressEveryMs: number;
  log: Logger;
};

function failed(code: string, message: string): OperationResult {
  return { outcome: 'failed', error: { code, message } };
}

function progressOf(page: SignInPage | null, codeTaken: boolean): OperationProgress {
  if (!page) return { message: 'Starting the sign-in' };
  const needsCode = page.needsCode && !codeTaken;
  return {
    message: needsCode
      ? 'Waiting for the code the sign-in page shows'
      : codeTaken
        ? 'Checking the code'
        : 'Waiting for the sign-in to finish',
    sign_in: {
      url: page.url,
      ...(page.userCode ? { user_code: page.userCode } : {}),
      needs_code: needsCode,
    },
  };
}

/** Switch no longer lets this controller work on the operation: cancelled, expired or gone. */
function lost(error: unknown): boolean {
  return error instanceof ControllerApiError && [404, 409, 410].includes(error.status);
}

/**
 * A `provider.login` operation with `method: "browser"`: runs the provider's
 * own sign-in here, reporting its page as the operation's progress for the
 * person signing in from a browser elsewhere, and typing in the code they
 * send back. The login it ends with is sealed to this machine's own key and
 * kept by Switch as a login given to the machine, then taken up exactly as a
 * pasted one is, so it outlives this controller and is withdrawn the same way.
 * A CLI that keeps its login on the machine itself (Cursor, Antigravity) has
 * nothing to seal: the machine is then signed in as by hand, and checked.
 */
export async function signInWithBrowser(
  operationId: string,
  provider: BrowserSignInProvider,
  deps: BrowserLoginDeps
): Promise<OperationResult> {
  const keys = deps.keys;
  if (!keys)
    return failed(
      'operation_unsupported',
      'This controller keeps no key across starts (its credential is handed over), so a login made here could not be kept. Sign in on the machine itself.'
    );
  const binaryPath = await deps.binaryPath(provider);
  if (!binaryPath)
    return failed('provider_not_installed', `${provider} is not installed on this machine.`);

  const signIn = startBrowserSignIn({
    provider,
    binaryPath,
    timeoutMs: deps.timeoutMs,
    signal: deps.signal,
    onPage: () => {},
  });
  let ended = false;
  const settled = signIn.done.then(
    () => {
      ended = true;
    },
    () => {
      ended = true;
    }
  );
  deps.log.info('Started a browser sign-in', { operationId, provider });
  let codeTaken = false;
  while (!ended) {
    try {
      const sent = await deps.client.operationProgress(
        operationId,
        progressOf(signIn.page(), codeTaken)
      );
      if (sent && !codeTaken) {
        codeTaken = true;
        try {
          signIn.enterCode(sent.code);
          deps.log.info('Typed in the code sent for a browser sign-in', { operationId, provider });
        } catch (error) {
          deps.log.warn('Could not type in the code sent for a browser sign-in', {
            operationId,
            error: errorMessage(error),
          });
        }
      }
    } catch (error) {
      if (isRevoked(error) || lost(error)) {
        signIn.cancel('The sign-in was cancelled.');
        await settled;
        throw error;
      }
      // Its lease outlasts a few missed reports; the sign-in carries on.
      deps.log.warn('Could not report a browser sign-in’s progress', {
        operationId,
        error: errorMessage(error),
      });
    }
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, deps.progressEveryMs)),
      settled,
    ]);
  }

  let login;
  try {
    login = await signIn.done;
  } catch (error) {
    deps.log.warn('A browser sign-in ended without a login', {
      operationId,
      provider,
      error: errorMessage(error),
    });
    return failed('provider_login_missing', errorMessage(error));
  }
  if (login.kind === 'kept-on-machine') {
    deps.log.info('A browser sign-in left the provider signed in on this machine', {
      operationId,
      provider,
    });
  } else {
    await deps.client.keepBrowserLogin(
      operationId,
      sealProviderLogin({
        publicKey: keys.publicKey,
        controllerId: deps.controllerId,
        provider,
        login,
      })
    );
    deps.log.info('Kept the login a browser sign-in ended with', { operationId, provider });
  }
  const { status, problem } = await deps.takeUpLogin(provider);
  if (status.auth === 'ok') return { outcome: 'succeeded', output: { provider: status } };
  return failed(
    problem?.code ?? status.reason ?? 'provider_login_missing',
    problem?.message ?? `${provider} does not sign in with the login the sign-in ended with.`
  );
}
