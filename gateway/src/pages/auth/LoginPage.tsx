import {
  Alert,
  Box,
  Button,
  Card,
  CircularProgress,
  Divider,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useState } from "react";
import {
  type AuthConfig,
  fetchAuthConfig,
  oidcLoginUrl,
} from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { readPendingInvite } from "../../data/sessionState";

export default function LoginPage() {
  const { login, signUp } = useAuth();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);

  useEffect(() => {
    fetchAuthConfig().then(setAuthConfig, (err: unknown) =>
      console.warn("Could not read how Switch signs people in here; offering password sign-in", err),
    );
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setSubmitting(true);
      setError(null);
      try {
        if (creating) await signUp({ email, password, name: name.trim() || null });
        else await login(email, password);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : creating
              ? "Your account could not be created"
              : "Login failed",
        );
      } finally {
        setSubmitting(false);
      }
    },
    [creating, name, email, password, login, signUp],
  );

  // Default to showing the password form if the config call hasn't resolved
  // (or failed) so password login always remains reachable.
  const passwordLoginEnabled = authConfig?.password_login_enabled ?? true;
  const oidcEnabled = authConfig?.oidc_enabled ?? false;
  const providerLabel = authConfig?.oidc_provider_label ?? "SSO";
  const canSignUp = passwordLoginEnabled && authConfig?.web_signup_enabled === true;
  const subtitle = creating
    ? "Create your Switch account. Your agents run on Switch, so there is nothing to install."
    : readPendingInvite()
    ? "Sign in to accept your invitation."
    : oidcEnabled && authConfig?.signup_mode === "open"
      ? `Sign in with ${providerLabel} to create a workspace or join one.`
      : "Sign in to manage your agents, rooms and resources.";

  return (
    <Box
      sx={{
        display: "flex",
        height: "100vh",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "var(--sw-canvas)",
      }}
    >
      <Card
        component="form"
        onSubmit={handleSubmit}
        sx={{ width: 380, p: 4, boxShadow: "var(--sw-shadow-surface)" }}
      >
        <Typography variant="h6" sx={{ mb: 0.5 }}>
          Switch Gateway
        </Typography>
        <Typography variant="body2" sx={{ mb: 3, color: "text.secondary" }}>
          {subtitle}
        </Typography>
        <Stack spacing={2}>
          {error && <Alert severity="error">{error}</Alert>}
          {passwordLoginEnabled && (
            <>
              {creating && (
                <TextField
                  label="Your name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                />
              )}
              <TextField
                label="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <TextField
                label="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <Button
                type="submit"
                variant="contained"
                fullWidth
                disabled={submitting}
                startIcon={
                  submitting ? <CircularProgress size={16} /> : undefined
                }
              >
                {creating ? "Create account" : "Sign in"}
              </Button>
              {canSignUp && (
                <Button
                  variant="text"
                  size="small"
                  onClick={() => {
                    setCreating(!creating);
                    setError(null);
                  }}
                >
                  {creating ? "Have an account? Sign in" : "New to Switch? Create an account"}
                </Button>
              )}
            </>
          )}
          {passwordLoginEnabled && oidcEnabled && <Divider>or</Divider>}
          {oidcEnabled && (
            <Button
              variant="outlined"
              fullWidth
              onClick={() => {
                window.location.href = oidcLoginUrl();
              }}
            >
              {`Log in with ${providerLabel}`}
            </Button>
          )}
        </Stack>
      </Card>
    </Box>
  );
}
