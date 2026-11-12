import { Box, Card, CircularProgress, Link, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";
import { useAuth } from "../../data/AuthContext";
import SwitchLogo from "../../layout/SwitchLogo";

/** The canvas the screens before the app sit on, holding its content in the
 * middle of the window. */
function Backdrop({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        display: "flex",
        minHeight: "100vh",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "background.canvas",
        px: 2,
        py: 4,
      }}
    >
      {children}
    </Box>
  );
}

/** The layout of every screen shown before the app: signing in, accepting an
 * invitation, choosing a workspace, and creating one. The mark, a title and
 * one line on what to do, the screen's own content, and a footer. */
export default function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: ReactNode;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <Backdrop>
      <Card
        component="main"
        sx={{
          width: "100%",
          maxWidth: 400,
          p: { xs: 3, sm: 4 },
          boxShadow: 2,
        }}
      >
        <Stack sx={{ alignItems: "center", textAlign: "center", mb: 3 }}>
          <Box sx={{ mb: 2, display: "flex" }}>
            <SwitchLogo size="40px" />
          </Box>
          <Typography variant="h3" component="h1">
            {title}
          </Typography>
          <Typography variant="body2" sx={{ mt: 0.5, color: "text.secondary" }}>
            {subtitle}
          </Typography>
        </Stack>
        {children}
        {footer !== null && (
          <Box sx={{ mt: 3, textAlign: "center" }}>{footer}</Box>
        )}
      </Card>
    </Backdrop>
  );
}

/** Who is signed in, and the way out: for the screens a signed-in person sees
 * before they are in a workspace. */
export function SignedInFooter() {
  const { user, logout } = useAuth();
  return (
    <Typography variant="body2" sx={{ color: "text.secondary", overflowWrap: "anywhere" }}>
      {user ? `Signed in as ${user.email} · ` : ""}
      <Link component="button" type="button" onClick={logout} color="inherit" sx={{ verticalAlign: "baseline" }}>
        Sign out
      </Link>
    </Typography>
  );
}

/** While the session is read: the mark, and that something is happening. */
export function AuthLoading() {
  return (
    <Backdrop>
      <Stack sx={{ alignItems: "center", gap: 3 }}>
        <SwitchLogo size="40px" />
        <CircularProgress size={24} aria-label="Loading" />
      </Stack>
    </Backdrop>
  );
}
