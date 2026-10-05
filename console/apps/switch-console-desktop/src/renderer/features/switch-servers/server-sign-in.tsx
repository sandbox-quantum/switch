import { TriangleAlert } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { Label } from '@renderer/lib/ui/label';
import type { SignupMachine, SwitchAuthConfig } from '@shared/core/switch-servers/switch-servers';
import { switchServersStore } from './switch-servers-store';
import { managedCloudServerId } from './use-cloud-launches';

/**
 * Signing in to a Switch server, wherever that is asked for.
 *
 * Two surfaces ask: the wizard that connects to a server for the first time,
 * and the panel on the page of a server whose session has gone. They read the
 * same auth config and call the same methods, so both live here — a login
 * method added to one and not the other would be invisible until someone tried
 * to use it.
 */
export type ServerSignInMode = 'signIn' | 'signUp';

export type SignUpFieldErrors = {
  email?: string;
  password?: string;
  confirmPassword?: string;
};

/** What a successful submit hands on: the new account's machine status after
 * a sign-up, null after a sign-in. */
export type SignedIn = { machine: SignupMachine | null };

/** Why a just-created account's cloud machine is not starting, or null when it
 * is (or when this was a sign-in, which warms it separately). */
export function machineUnavailableReason({ machine }: SignedIn): string | null {
  if (machine?.status !== 'unavailable') return null;
  return machine.reason ?? 'The server did not say why.';
}

export type ServerSignIn = {
  /** Which methods the server offers, or null while that is still unknown. */
  config: SwitchAuthConfig | null;
  /** Whether the last attempt to read sign-in options failed. The page never
   * lets this evict a reachable server (see `isUnreachable` on the store), so
   * this is the only place that failure is visible — `config` may be a stale
   * answer from before the endpoint broke, or null if it never succeeded. */
  configCheckFailed: boolean;
  /** Whether a sign-in-options read is in flight right now — checked before
   * `configCheckFailed` so a fresh retry after a failure is not reported as
   * still failing while it is still running. */
  configChecking: boolean;
  /** Signing in to an existing account, or creating one. Only `signIn` unless
   * the server allows sign-up. */
  mode: ServerSignInMode;
  setMode: (mode: ServerSignInMode) => void;
  email: string;
  password: string;
  confirmPassword: string;
  setEmail: (value: string) => void;
  setPassword: (value: string) => void;
  setConfirmPassword: (value: string) => void;
  /** Per-field problems found before a sign-up was sent. */
  fieldErrors: SignUpFieldErrors;
  submitting: boolean;
  /** The server's own refusal, kept out of the global banner so it lands
   * beside the form that caused it. */
  error: string | null;
  canSubmitPassword: boolean;
  /** Both resolve true only when the session is live afterwards. */
  signInWithPassword: () => Promise<boolean>;
  signInWithOidc: () => Promise<boolean>;
  /** The email form's action for the current mode; null when not signed in. */
  submitForm: () => Promise<SignedIn | null>;
  /** Whether the email form's button can be pressed in the current mode. */
  canSubmitForm: boolean;
  submitLabel: string;
};

/**
 * Warm the signed-in user's cloud machine on the Switch-managed server, so it
 * is starting while they set up their first agent. Not awaited: sign-in is
 * done whether or not the machine starts, so a refusal is a notice rather than
 * a failed sign-in.
 */
function warmCloudMachine(serverId: string): void {
  if (serverId !== managedCloudServerId()) return;
  rpc.switchServers.ensureCloudMachine(serverId).catch((cause: unknown) => {
    toast({
      title: 'Your cloud machine did not start',
      description: failureText(cause, 'Switch could not start your cloud machine.'),
      variant: 'destructive',
    });
  });
}

function validateSignUp(email: string, password: string, confirm: string): SignUpFieldErrors {
  const errors: SignUpFieldErrors = {};
  if (!email.trim()) errors.email = 'Enter your email.';
  if (!password) errors.password = 'Enter a password.';
  if (!confirm) errors.confirmPassword = 'Confirm your password.';
  else if (password && confirm !== password) errors.confirmPassword = 'Passwords do not match.';
  return errors;
}

export function useServerSignIn(serverId: string): ServerSignIn {
  const [mode, setModeState] = useState<ServerSignInMode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<SignUpFieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void switchServersStore.ensureAuthConfig(serverId);
  }, [serverId]);

  const attempt = async (run: () => Promise<boolean>): Promise<boolean> => {
    setSubmitting(true);
    setError(null);
    try {
      const ok = await run();
      if (!ok) setError(switchServersStore.errorText ?? 'Could not sign in.');
      if (ok) warmCloudMachine(serverId);
      return ok;
    } finally {
      setSubmitting(false);
    }
  };

  const signInWithPassword = () =>
    attempt(() => switchServersStore.passwordLogin(serverId, email, password));

  const signUp = async (): Promise<SignupMachine | null> => {
    const errors = validateSignUp(email, password, confirmPassword);
    setFieldErrors(errors);
    setError(null);
    if (Object.keys(errors).length > 0) return null;
    setSubmitting(true);
    try {
      const machine = await switchServersStore.signup({ serverId, email: email.trim(), password });
      if (!machine) setError(switchServersStore.errorText ?? 'Could not create the account.');
      return machine;
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmitPassword = email.length > 0 && password.length > 0;

  return {
    config: switchServersStore.authConfigFor(serverId),
    configCheckFailed: switchServersStore.authConfigCheckFailed(serverId),
    configChecking: switchServersStore.authConfigChecking(serverId),
    mode,
    setMode: (next) => {
      setModeState(next);
      setFieldErrors({});
      setError(null);
    },
    email,
    password,
    confirmPassword,
    setEmail,
    setPassword,
    setConfirmPassword,
    fieldErrors,
    submitting,
    error,
    canSubmitPassword,
    signInWithPassword,
    signInWithOidc: () => attempt(() => switchServersStore.oidcLogin(serverId)),
    submitForm: async () => {
      if (mode === 'signUp') {
        const machine = await signUp();
        return machine ? { machine } : null;
      }
      return (await signInWithPassword()) ? { machine: null } : null;
    },
    canSubmitForm: !submitting && (mode === 'signUp' || canSubmitPassword),
    submitLabel:
      mode === 'signUp'
        ? submitting
          ? 'Creating account…'
          : 'Create account'
        : submitting
          ? 'Signing in…'
          : 'Sign in',
  };
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="text-xs text-destructive">
      {message}
    </p>
  );
}

/**
 * The fields themselves: email and password when the server takes them, the
 * provider button when it speaks OIDC, and both separated by an "or" when it
 * offers the two. When the server allows sign-up, a link switches the email
 * form to creating an account.
 *
 * `passwordSubmit` is where the caller puts its own submit button. The wizard
 * has a dialog footer to put it in and passes nothing; the server page has no
 * footer, so its button goes under the password field where it belongs.
 */
export const ServerSignInFields = observer(function ServerSignInFields({
  signIn,
  idPrefix,
  gatewayUrl,
  passwordSubmit,
  onSignedIn,
}: {
  signIn: ServerSignIn;
  /** Distinguishes the label/input pairs when two of these are ever on screen. */
  idPrefix: string;
  /** Shown under the password as the address being signed in to. Omit where
   * the surrounding page already says which server this is. */
  gatewayUrl?: string;
  passwordSubmit?: React.ReactNode;
  onSignedIn: (signedIn: SignedIn) => void;
}) {
  const { config, mode, fieldErrors } = signIn;
  const signingUp = mode === 'signUp';

  const submitForm = async () => {
    if (!signIn.canSubmitForm) return;
    const signedIn = await signIn.submitForm();
    if (signedIn) onSignedIn(signedIn);
  };

  const submitOidc = async () => {
    if (signIn.submitting) return;
    if (await signIn.signInWithOidc()) onSignedIn({ machine: null });
  };

  if (!config) {
    return (
      <p className="text-sm text-foreground-muted">
        {signIn.configCheckFailed && !signIn.configChecking
          ? 'Could not check sign-in options.'
          : 'Checking sign-in options…'}
      </p>
    );
  }

  const showEmailForm = signingUp || config.passwordLoginEnabled;
  const showOidc = !signingUp && config.oidcEnabled;

  return (
    <div className="flex flex-col gap-4">
      {signIn.configCheckFailed && (
        <p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
          <TriangleAlert className="size-3 shrink-0" />
          Could not check for updated sign-in options — showing what was last known.
        </p>
      )}

      {showEmailForm && (
        <div className="flex flex-col gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-email`}>Email</Label>
            <Input
              id={`${idPrefix}-email`}
              type="email"
              autoComplete="username"
              placeholder="you@company.com"
              value={signIn.email}
              aria-invalid={signingUp && fieldErrors.email ? true : undefined}
              aria-describedby={
                signingUp && fieldErrors.email ? `${idPrefix}-email-error` : undefined
              }
              onChange={(e) => signIn.setEmail(e.target.value)}
            />
            {signingUp && <FieldError id={`${idPrefix}-email-error`} message={fieldErrors.email} />}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-password`}>Password</Label>
            <Input
              id={`${idPrefix}-password`}
              type="password"
              autoComplete={signingUp ? 'new-password' : 'current-password'}
              value={signIn.password}
              aria-invalid={signingUp && fieldErrors.password ? true : undefined}
              aria-describedby={
                signingUp && fieldErrors.password ? `${idPrefix}-password-error` : undefined
              }
              onChange={(e) => signIn.setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !signingUp) void submitForm();
              }}
            />
            {signingUp && (
              <FieldError id={`${idPrefix}-password-error`} message={fieldErrors.password} />
            )}
            {gatewayUrl && !signingUp && (
              <p className="truncate text-xs text-foreground-muted">Signing in to {gatewayUrl}</p>
            )}
          </div>
          {signingUp && (
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-confirm-password`}>Confirm password</Label>
              <Input
                id={`${idPrefix}-confirm-password`}
                type="password"
                autoComplete="new-password"
                value={signIn.confirmPassword}
                aria-invalid={fieldErrors.confirmPassword ? true : undefined}
                aria-describedby={
                  fieldErrors.confirmPassword ? `${idPrefix}-confirm-password-error` : undefined
                }
                onChange={(e) => signIn.setConfirmPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitForm();
                }}
              />
              <FieldError
                id={`${idPrefix}-confirm-password-error`}
                message={fieldErrors.confirmPassword}
              />
              {gatewayUrl && (
                <p className="truncate text-xs text-foreground-muted">
                  Creating an account on {gatewayUrl}
                </p>
              )}
            </div>
          )}
          {passwordSubmit}
        </div>
      )}

      {showOidc && (
        <div className="flex flex-col gap-3">
          {config.passwordLoginEnabled && (
            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-border" />
              <span className="text-xs text-foreground-muted">or</span>
              <span className="h-px flex-1 bg-border" />
            </div>
          )}
          <Button
            variant="outline"
            className="w-full"
            disabled={signIn.submitting}
            onClick={() => void submitOidc()}
          >
            Continue with {config.oidcProviderLabel ?? 'SSO'}
          </Button>
        </div>
      )}

      {config.signupEnabled && (
        <p className="text-xs text-foreground-muted">
          {signingUp ? 'Already have an account?' : 'New to Switch?'}{' '}
          <button
            type="button"
            className="bg-transparent p-0 font-medium text-foreground underline-offset-2 hover:bg-transparent hover:underline"
            disabled={signIn.submitting}
            onClick={() => signIn.setMode(signingUp ? 'signIn' : 'signUp')}
          >
            {signingUp ? 'Sign in' : 'Create account'}
          </button>
        </p>
      )}

      {!config.passwordLoginEnabled && !config.oidcEnabled && !config.signupEnabled && (
        <p className="text-sm text-destructive">This server has no enabled sign-in methods.</p>
      )}

      {signIn.error && (
        <p role="alert" className="text-xs text-destructive">
          {signIn.error}
        </p>
      )}
    </div>
  );
});
