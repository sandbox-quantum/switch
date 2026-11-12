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
import { type AuthConfig, fetchAuthConfig, oidcLoginUrl } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import {
  handedOffRecently,
  noteHandOff,
  readPendingInvite,
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
 * on purpose, and whether it is back from the identity provider too soon for
 * the sign-in to have finished. Either one keeps the page from handing off. */
interface Arrival {
  signedOut: boolean;
  didNotFinish: boolean;
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [configState, setConfigState] = useState<ConfigState>({ status: "loading" });
  const [arrival] = useState<Arrival>(() => ({
    signedOut: signedOutOnPurpose(),
    didNotFinish: handedOffRecently(Date.now()),
  }));

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
  const handOffTo =
    only !== null && !arrival.signedOut && !arrival.didNotFinish ? oidcLoginUrl(only.id) : null;

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
          {arrival.didNotFinish && (
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
                window.location.href = oidcLoginUrl(option.id);
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
