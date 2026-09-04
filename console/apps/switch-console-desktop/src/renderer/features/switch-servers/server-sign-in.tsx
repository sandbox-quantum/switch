import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { Label } from '@renderer/lib/ui/label';
import type { SwitchAuthConfig } from '@shared/core/switch-servers/switch-servers';
import { switchServersStore } from './switch-servers-store';

/**
 * Signing in to a Switch server, wherever that is asked for.
 *
 * Two surfaces ask: the wizard that connects to a server for the first time,
 * and the panel on the page of a server whose session has gone. They read the
 * same auth config and call the same two methods, so both live here — a login
 * method added to one and not the other would be invisible until someone tried
 * to use it.
 */
export type ServerSignIn = {
  /** Which methods the server offers, or null while that is still unknown. */
  config: SwitchAuthConfig | null;
  email: string;
  password: string;
  setEmail: (value: string) => void;
  setPassword: (value: string) => void;
  submitting: boolean;
  /** The server's own refusal, kept out of the global banner so it lands
   * beside the form that caused it. */
  error: string | null;
  canSubmitPassword: boolean;
  /** Both resolve true only when the session is live afterwards. */
  signInWithPassword: () => Promise<boolean>;
  signInWithOidc: () => Promise<boolean>;
};

export function useServerSignIn(serverId: string): ServerSignIn {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
      return ok;
    } finally {
      setSubmitting(false);
    }
  };

  return {
    config: switchServersStore.authConfigFor(serverId),
    email,
    password,
    setEmail,
    setPassword,
    submitting,
    error,
    canSubmitPassword: email.length > 0 && password.length > 0,
    signInWithPassword: () =>
      attempt(() => switchServersStore.passwordLogin(serverId, email, password)),
    signInWithOidc: () => attempt(() => switchServersStore.oidcLogin(serverId)),
  };
}

/**
 * The fields themselves: email and password when the server takes them, the
 * provider button when it speaks OIDC, and both separated by an "or" when it
 * offers the two.
 *
 * `passwordSubmit` is where the caller puts its own Sign in button. The wizard
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
  onSignedIn: () => void;
}) {
  const { config } = signIn;

  const submitPassword = async () => {
    if (!signIn.canSubmitPassword || signIn.submitting) return;
    if (await signIn.signInWithPassword()) onSignedIn();
  };

  const submitOidc = async () => {
    if (signIn.submitting) return;
    if (await signIn.signInWithOidc()) onSignedIn();
  };

  if (!config) {
    return <p className="text-sm text-foreground-muted">Checking sign-in options…</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {config.passwordLoginEnabled && (
        <div className="flex flex-col gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-email`}>Email</Label>
            <Input
              id={`${idPrefix}-email`}
              type="email"
              autoComplete="username"
              placeholder="you@company.com"
              value={signIn.email}
              onChange={(e) => signIn.setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-password`}>Password</Label>
            <Input
              id={`${idPrefix}-password`}
              type="password"
              autoComplete="current-password"
              value={signIn.password}
              onChange={(e) => signIn.setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitPassword();
              }}
            />
            {gatewayUrl && (
              <p className="truncate text-xs text-foreground-muted">Signing in to {gatewayUrl}</p>
            )}
          </div>
          {passwordSubmit}
        </div>
      )}

      {config.oidcEnabled && (
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

      {!config.passwordLoginEnabled && !config.oidcEnabled && (
        <p className="text-sm text-destructive">This server has no enabled sign-in methods.</p>
      )}

      {signIn.error && <p className="text-xs text-destructive">{signIn.error}</p>}
    </div>
  );
});
