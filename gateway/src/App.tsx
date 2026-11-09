import { Alert, Box, Button, CircularProgress } from "@mui/material";
import { Suspense, lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AuthProvider, useAuth } from "./data/AuthContext";
import { appView, readPendingInvite } from "./data/sessionState";
import PageShell from "./layout/PageShell";
import { renderRoutes } from "./routes/renderRoutes";
import { NotFoundPage } from "./routes/StatusPages";
import LoginPage from "./pages/auth/LoginPage";
import AcceptInvitePage from "./pages/onboarding/AcceptInvitePage";
import InviteCapture from "./pages/onboarding/InviteCapture";
import OnboardingPage from "./pages/onboarding/OnboardingPage";
import WorkspacePickerPage from "./pages/onboarding/WorkspacePickerPage";

function FullScreen({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={{
        display: "flex",
        height: "100vh",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </Box>
  );
}

export function AppRoutes() {
  const { session, loading, loadError, capabilities } = useAuth();

  if (loading) {
    return (
      <FullScreen>
        <CircularProgress />
      </FullScreen>
    );
  }

  if (loadError !== null) {
    return (
      <FullScreen>
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => window.location.reload()}>
              Retry
            </Button>
          }
        >
          Could not load your session: {loadError}
        </Alert>
      </FullScreen>
    );
  }

  const pendingInvite = readPendingInvite();
  const view = appView(session, pendingInvite);

  if (view === "signed_out") {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/invite" element={<InviteCapture />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  if (view !== "ready") {
    const screen =
      view === "accept_invite" && pendingInvite !== null ? (
        <AcceptInvitePage token={pendingInvite} />
      ) : view === "needs_selection" ? (
        <WorkspacePickerPage />
      ) : (
        <OnboardingPage />
      );
    return (
      <Routes>
        <Route path="/invite" element={<InviteCapture />} />
        <Route path="/" element={screen} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  const layout = capabilities.features.gateway_v2 ? "v2" : "current";
  return (
    <Routes>
      <Route element={<PageShell layout={layout} />}>
        {renderRoutes(layout)}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      <Route path="/invite" element={<InviteCapture />} />
      <Route path="/login" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

// Dev builds only. A production build reads `import.meta.env.DEV` as false and
// drops this import with it, and `scripts/check-no-dev-tools.mjs` fails the
// build if any of `src/dev/` is left in.
const DevRoleSwitcher = import.meta.env.DEV ? lazy(() => import("./dev/DevRoleSwitcher")) : null;

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
        {DevRoleSwitcher !== null && (
          <Suspense fallback={null}>
            <DevRoleSwitcher />
          </Suspense>
        )}
      </AuthProvider>
    </BrowserRouter>
  );
}
