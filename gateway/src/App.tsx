import { Alert, Box, Button, CircularProgress } from "@mui/material";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AuthProvider, useAuth } from "./data/AuthContext";
import { appView, readPendingInvite } from "./data/sessionState";
import PageShell from "./layout/PageShell";
import AgentDetailPage from "./pages/agents/AgentDetailPage";
import AgentsPage from "./pages/agents/AgentsPage";
import LoginPage from "./pages/auth/LoginPage";
import CollaborationsPage from "./pages/collaborations/CollaborationsPage";
import EcosystemGraphPage from "./pages/ecosystem/EcosystemGraphPage";
import RegistrationKeysPage from "./pages/registration-keys/RegistrationKeysPage";
import DocumentDetailPage from "./pages/resources/DocumentDetailPage";
import PackageDetailPage from "./pages/resources/PackageDetailPage";
import ReferenceDetailPage from "./pages/resources/ReferenceDetailPage";
import ResourcesPage from "./pages/resources/ResourcesPage";
import TemplateDetailPage from "./pages/resources/TemplateDetailPage";
import CreateRoomPage from "./pages/rooms/CreateRoomPage";
import GroupsPage from "./pages/rooms/GroupsPage";
import RoomDetailPage from "./pages/rooms/RoomDetailPage";
import RoomScopedDocumentView from "./pages/rooms/RoomScopedDocumentView";
import RoomsGraphPage from "./pages/rooms/RoomsGraphPage";
import RoomsPage from "./pages/rooms/RoomsPage";
import AcceptInvitePage from "./pages/onboarding/AcceptInvitePage";
import InviteCapture from "./pages/onboarding/InviteCapture";
import OnboardingPage from "./pages/onboarding/OnboardingPage";
import WorkspacePickerPage from "./pages/onboarding/WorkspacePickerPage";
import UsersPage from "./pages/users/UsersPage";
import WorkspacePage from "./pages/workspace/WorkspacePage";

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
  const { session, loading, loadError } = useAuth();

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

  return (
    <Routes>
      <Route element={<PageShell />}>
        <Route index element={<Navigate to="/rooms" replace />} />
        <Route path="ecosystem" element={<EcosystemGraphPage />} />
        <Route path="rooms" element={<RoomsPage />} />
        <Route path="rooms/new" element={<CreateRoomPage />} />
        <Route path="rooms/groups" element={<GroupsPage />} />
        <Route path="rooms/graph" element={<RoomsGraphPage />} />
        <Route path="rooms/:roomId" element={<RoomDetailPage />} />
        <Route
          path="rooms/:roomId/documents/:documentId"
          element={<RoomScopedDocumentView />}
        />
        <Route path="resources" element={<ResourcesPage />} />
        <Route
          path="resources/references/:id"
          element={<ReferenceDetailPage />}
        />
        <Route
          path="resources/documents/:id"
          element={<DocumentDetailPage />}
        />
        <Route
          path="resources/packages/:id"
          element={<PackageDetailPage />}
        />
        <Route
          path="resources/templates/:id"
          element={<TemplateDetailPage />}
        />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="agents/:agentId" element={<AgentDetailPage />} />
        <Route path="collaborations" element={<CollaborationsPage />} />
        <Route path="registration-keys" element={<RegistrationKeysPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="workspace" element={<WorkspacePage />} />
      </Route>
      <Route path="/invite" element={<InviteCapture />} />
      <Route path="/login" element={<Navigate to="/" replace />} />
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
