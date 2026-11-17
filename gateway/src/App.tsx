import { Alert, Button, Stack } from "@mui/material";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { AuthProvider, useAuth } from "./data/AuthContext";
import {
  appView,
  dashboardLocation,
  nextAfterSignIn,
  readPendingInvite,
} from "./data/sessionState";
import { DevRoleCorner } from "./layout/DevRoleSlot";
import PageShell from "./layout/PageShell";
import { renderRoutes } from "./routes/renderRoutes";
import { NotFoundPage } from "./routes/StatusPages";
import AuthLayout, { AuthLoading } from "./pages/auth/AuthLayout";
import LoginPage from "./pages/auth/LoginPage";
import AcceptInvitePage from "./pages/onboarding/AcceptInvitePage";
import InviteCapture from "./pages/onboarding/InviteCapture";
import OnboardingPage from "./pages/onboarding/OnboardingPage";
import WorkspacePickerPage from "./pages/onboarding/WorkspacePickerPage";

/** Signed out anywhere but sign-in: to sign-in, saying where to come back to. */
function ToSignIn() {
  const { pathname, search } = useLocation();
  const next = nextAfterSignIn(pathname, search);
  return (
    <Navigate to={next === null ? "/login" : `/login?${new URLSearchParams({ next })}`} replace />
  );
}

/** Signed in on sign-in: on to where it was asked to come back to. */
function FromSignIn() {
  const { search } = useLocation();
  return <Navigate to={dashboardLocation(new URLSearchParams(search).get("next")) ?? "/"} replace />;
}

export function AppRoutes() {
  const { session, loading, loadError, capabilities } = useAuth();

  if (loading) return <AuthLoading />;

  if (loadError !== null) {
    return (
      <AuthLayout
        title="Could not load your session"
        subtitle="Try again in a moment."
        footer={null}
      >
        <Stack spacing={2}>
          <Alert severity="error">{loadError}</Alert>
          <Button variant="contained" fullWidth onClick={() => window.location.reload()}>
            Retry
          </Button>
        </Stack>
      </AuthLayout>
    );
  }

  const pendingInvite = readPendingInvite();
  const view = appView(session, pendingInvite);

  if (view === "signed_out") {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/invite" element={<InviteCapture />} />
        <Route path="*" element={<ToSignIn />} />
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
      <>
        <Routes>
          <Route path="/invite" element={<InviteCapture />} />
          <Route path="/" element={screen} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <DevRoleCorner />
      </>
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
      <Route path="/login" element={<FromSignIn />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
