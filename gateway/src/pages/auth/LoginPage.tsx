import {
  Alert,
  Box,
  Button,
  Card,
  CircularProgress,
  Divider,
  Stack,
  Step,
  StepLabel,
  Stepper,
  TextField,
  Typography,
} from "@mui/material";
import { oidcSignInButtons } from "@switch-console/chat-ui/model/sign-in-options";
import { useCallback, useEffect, useState } from "react";
import {
  type AuthConfig,
  createTenant,
  fetchAuthConfig,
  oidcLoginUrl,
  signUp as createAccount,
} from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { readPendingInvite } from "../../data/sessionState";

/** What a new person's workspace is called until they name it. */
export function suggestedWorkspaceName(name: string): string {
  const first = name.trim().split(/\s+/)[0];
  return first ? `${first}'s workspace` : "My workspace";
}

export default function LoginPage() {
  const { login, signUp, refresh } = useAuth();
  const [creating, setCreating] = useState(false);
  const [naming, setNaming] = useState(false);
  const [accountMade, setAccountMade] = useState(false);
  const [workspace, setWorkspace] = useState<string | null>(null);
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

  // Default to showing the password form if the config call hasn't resolved
  // (or failed) so password login always remains reachable.
  const passwordLoginEnabled = authConfig?.password_login_enabled ?? true;
  const oidcEnabled = authConfig?.oidc_enabled ?? false;
  const oidcButtons = oidcSignInButtons(
    authConfig?.oidc_login_options ?? [],
    authConfig?.oidc_provider_label ?? null,
  );
  const canSignUp = passwordLoginEnabled && authConfig?.web_signup_enabled === true;
  // Under open sign-up a new account joins no workspace, so it names its own.
  const ownWorkspace = canSignUp && authConfig?.signup_mode === "open";
  const oidcOpensAccounts = oidcEnabled && authConfig?.signup_mode === "open";
  const workspaceName = workspace ?? suggestedWorkspaceName(name);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (creating && ownWorkspace && !naming) {
        setNaming(true);
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        if (naming) {
          if (!accountMade) {
            await createAccount({ email, password, display_name: name.trim() || null });
            setAccountMade(true);
          }
          try {
            await createTenant(workspaceName.trim());
          } catch (err) {
            throw new Error(
              `Your account was created, but not your workspace: ${err instanceof Error ? err.message : "it could not be created"}`,
            );
          }
          await refresh();
        } else if (creating) await signUp({ email, password, name: name.trim() || null });
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
    [creating, naming, accountMade, ownWorkspace, workspaceName, name, email, password, login, signUp, refresh],
  );

  const subtitle = naming
    ? "Name your workspace: where your agents, rooms and teammates live. You can rename it later."
    : creating
    ? "Create your Switch account. Your agents run on Switch, so there is nothing to install."
    : readPendingInvite()
    ? "Sign in to accept your invitation."
    : canSignUp
      ? "Sign in, or create an account if you're new to Switch. Your agents run on Switch, so there is nothing to install."
      : oidcOpensAccounts
        ? "New to Switch? Signing in creates your account, and you can create a workspace or join one."
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
        {creating && ownWorkspace && (
          <Stepper activeStep={naming ? 1 : 0} sx={{ mb: 3 }}>
            <Step>
              <StepLabel>Your account</StepLabel>
            </Step>
            <Step>
              <StepLabel>Your workspace</StepLabel>
            </Step>
          </Stepper>
        )}
        <Stack spacing={2}>
          {error && <Alert severity="error">{error}</Alert>}
          {naming ? (
            <>
              <TextField
                label="Workspace name"
                value={workspaceName}
                onChange={(e) => setWorkspace(e.target.value)}
                required
                autoFocus
              />
              <Button
                type="submit"
                variant="contained"
                fullWidth
                disabled={submitting || workspaceName.trim() === ""}
                startIcon={submitting ? <CircularProgress size={16} /> : undefined}
              >
                {accountMade ? "Create workspace" : "Create account"}
              </Button>
              {!accountMade && (
                <Button
                  variant="text"
                  size="small"
                  disabled={submitting}
                  onClick={() => {
                    setNaming(false);
                    setError(null);
                  }}
                >
                  Back
                </Button>
              )}
            </>
          ) : passwordLoginEnabled && (
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
                {creating ? (ownWorkspace ? "Next" : "Create account") : "Sign in"}
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
          {!naming && passwordLoginEnabled && oidcEnabled && <Divider>or</Divider>}
          {!naming &&
            oidcEnabled &&
            oidcButtons.map((option) => (
              <Button
                key={option.id ?? "sso"}
                variant="outlined"
                fullWidth
                onClick={() => {
                  window.location.href = oidcLoginUrl(option.id);
                }}
              >
                {`Continue with ${option.label}`}
              </Button>
            ))}
        </Stack>
      </Card>
    </Box>
  );
}
