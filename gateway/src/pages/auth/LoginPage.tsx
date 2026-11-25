import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  Stack,
  TextField,
} from "@mui/material";
import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { type AuthConfig, fetchAuthConfig, oidcLoginUrl } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import {
  clearSignOutNotice,
  dashboardLocation,
  handedOffRecently,
  noteHandOff,
  readPendingInvite,
  readSignOutNotice,
  signedOutOnPurpose,
} from "../../data/sessionState";
import AuthLayout, { AuthLoading } from "./AuthLayout";
import { leaveFor, onlyWayIn, ssoButtons } from "./handOff";
import signInProviderLogo from "./SignInProviderLogo";

type ConfigState =
  | { status: "loading" }
  | { status: "loaded"; config: AuthConfig }
  | { status: "failed"; message: string };

/** What this tab knew on arriving at sign-in: whether its person signed out
 * on purpose, whether it is back from the identity provider too soon for the
 * sign-in to have finished, why a sign-in failed, and what signing out could
 * not do. Any one keeps the page from handing off, so it can be read. */
interface Arrival {
  signedOut: boolean;
  didNotFinish: boolean;
  signInError: string | null;
  signOutNotice: string | null;
}

/** What the server's `?sign_in_error=` code means for the person signing in. */
export function signInErrorMessage(code: string): string {
  switch (code) {
    case "cancelled":
      return "Signing in was cancelled.";
    case "expired":
      return "That sign-in took too long or was already used. Try again.";
    case "email_unverified":
      return "Your identity provider doesn't say your email address is verified. Verify it there, then sign in again.";
    case "account_conflict":
      return "Your email address belongs to a Switch account that isn't linked to this sign-in yet. Sign in the way you did before, or ask your administrator to link your account.";
    case "signup_refused":
      return "Switch can't make an account for you from where you're signing in.";
    case "impersonation":
      return "Switch can't be signed in to on someone else's behalf. Sign in as yourself.";
    case "unavailable":
      return "Couldn't reach the identity provider to finish signing in. Try again in a moment.";
    case "misconfigured":
      return "Signing in isn't set up correctly here. Ask whoever runs Switch for you to check its sign-in settings.";
    case "refused":
      return "The identity provider refused the sign-in. Try again, and if it keeps happening, ask whoever runs Switch for you.";
    default:
      return `Signing in didn't finish (${code}). Try again.`;
  }
}

function subtitleFor(config: AuthConfig | null, arrival: Arrival): string {
  if (readPendingInvite()) return "You've been invited to a workspace. Sign in to accept.";
  if (arrival.signedOut) return "You're signed out.";
  if (config?.oidc_enabled && config.signup_mode === "open") {
    const via =
      config.oidc_login_options.length === 0
        ? ` with ${config.oidc_provider_label ?? "SSO"}`
        : "";
    return `New to Switch? Sign in${via} to create a workspace or join one.`;
  }
  return "Manage your agents, rooms and resources.";
}

export default function LoginPage() {
  const { login } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [configState, setConfigState] = useState<ConfigState>({ status: "loading" });
  const [arrival] = useState<Arrival>(() => ({
    signedOut: signedOutOnPurpose(),
    didNotFinish: handedOffRecently(Date.now()),
    signInError: new URLSearchParams(location.search).get("sign_in_error"),
    signOutNotice: readSignOutNotice(),
  }));
  const [next] = useState(() =>
    dashboardLocation(new URLSearchParams(location.search).get("next")),
  );

  // Said once: reloading the page, or coming back to it, does not say it
  // again.
  useEffect(() => {
    clearSignOutNotice();
    if (arrival.signInError !== null) {
      const query = new URLSearchParams(location.search);
      query.delete("sign_in_error");
      const search = query.toString();
      navigate({ search: search === "" ? "" : `?${search}` }, { replace: true });
    }
    // Once, on arrival: what it removes is already held in `arrival`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchAuthConfig().then(
      (config) => {
        if (!cancelled) setConfigState({ status: "loaded", config });
      },
      (err: unknown) => {
        if (!cancelled) {
          setConfigState({
            status: "failed",
            message: err instanceof Error ? err.message : "Could not load the ways to sign in",
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setSubmitting(true);
      setError(null);
      try {
        await login(email, password);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Login failed");
      } finally {
        setSubmitting(false);
      }
    },
    [email, password, login],
  );

  const config = configState.status === "loaded" ? configState.config : null;
  // Without the configuration the password form is offered, so password
  // sign-in stays reachable, and the warning above it says why.
  const passwordLoginEnabled = config?.password_login_enabled ?? true;
  const sso = config ? ssoButtons(config) : [];
  const only = config ? onlyWayIn(config) : null;
  const stay =
    arrival.signedOut ||
    arrival.didNotFinish ||
    arrival.signInError !== null ||
    arrival.signOutNotice !== null;
  const handOffTo = only !== null && !stay ? oidcLoginUrl(only.id, next) : null;

  useEffect(() => {
    if (handOffTo === null) return;
    noteHandOff(Date.now());
    leaveFor(handOffTo);
  }, [handOffTo]);

  if (handOffTo !== null) return <AuthLoading />;

  return (
    <AuthLayout title="Sign in to Switch" subtitle={subtitleFor(config, arrival)} footer={null}>
      {configState.status === "loading" ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 2 }}>
          <CircularProgress size={24} aria-label="Loading the ways to sign in" />
        </Box>
      ) : (
        <Stack spacing={2}>
          {configState.status === "failed" && (
            <Alert severity="warning">
              Could not load the ways to sign in, so only email and password are offered:{" "}
              {configState.message}
            </Alert>
          )}
          {arrival.signOutNotice !== null && (
            <Alert severity="warning">{arrival.signOutNotice}</Alert>
          )}
          {arrival.signInError !== null && (
            <Alert severity="error">{signInErrorMessage(arrival.signInError)}</Alert>
          )}
          {arrival.didNotFinish && arrival.signInError === null && (
            <Alert severity="warning">
              Signing in didn't finish, so you're back here. Try again, and if this keeps
              happening, check that this browser allows cookies for this site.
            </Alert>
          )}
          {error && <Alert severity="error">{error}</Alert>}
          {!passwordLoginEnabled && sso.length === 0 && (
            <Alert severity="error">
              No way to sign in is turned on here. Ask whoever runs Switch for you to set one up.
            </Alert>
          )}
          {passwordLoginEnabled && (
            <Stack component="form" onSubmit={handleSubmit} spacing={2}>
              <TextField
                label="Email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <TextField
                label="Password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <Button
                type="submit"
                variant="contained"
                fullWidth
                disabled={submitting}
                startIcon={submitting ? <CircularProgress size={16} /> : undefined}
              >
                Sign in
              </Button>
            </Stack>
          )}
          {passwordLoginEnabled && sso.length > 0 && (
            <Divider sx={{ typography: "caption", color: "text.secondary" }}>or</Divider>
          )}
          {sso.map((option) => (
            <Button
              key={option.id ?? "oidc"}
              variant="outlined"
              fullWidth
              startIcon={signInProviderLogo(option.id, option.label)}
              onClick={() => {
                noteHandOff(Date.now());
                window.location.href = oidcLoginUrl(option.id, next);
              }}
            >
              {`Continue with ${option.label}`}
            </Button>
          ))}
        </Stack>
      )}
    </AuthLayout>
  );
}
