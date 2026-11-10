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
import {
  type AuthConfig,
  type OidcLoginOption,
  fetchAuthConfig,
  oidcLoginUrl,
} from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { readPendingInvite } from "../../data/sessionState";
import AuthLayout from "./AuthLayout";

type ConfigState =
  | { status: "loading" }
  | { status: "loaded"; config: AuthConfig }
  | { status: "failed"; message: string };

/** The identity provider's buttons: one per configured login option, each
 * going straight to that way of signing in, or a single one that leaves the
 * choice to the provider. */
function ssoButtons(config: AuthConfig): { key: string; label: string; provider: string | null }[] {
  const providerLabel = config.oidc_provider_label ?? "SSO";
  if (config.oidc_login_options.length === 0) {
    return [{ key: "oidc", label: `Continue with ${providerLabel}`, provider: null }];
  }
  return config.oidc_login_options.map((option: OidcLoginOption) => ({
    key: option.id,
    label: `Continue with ${option.label}`,
    provider: option.id,
  }));
}

function subtitleFor(config: AuthConfig | null): string {
  if (readPendingInvite()) return "You've been invited to a workspace. Sign in to accept.";
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
  const sso = config?.oidc_enabled ? ssoButtons(config) : [];

  return (
    <AuthLayout title="Sign in to Switch" subtitle={subtitleFor(config)} footer={null}>
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
          {sso.map((button) => (
            <Button
              key={button.key}
              variant="outlined"
              fullWidth
              onClick={() => {
                window.location.href = oidcLoginUrl(button.provider);
              }}
            >
              {button.label}
            </Button>
          ))}
        </Stack>
      )}
    </AuthLayout>
  );
}
