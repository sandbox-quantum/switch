import { Alert, Box, Card, CircularProgress, Link, Stack, Typography } from "@mui/material";
import { type ReactNode, useState } from "react";
import { useAuth } from "../../data/AuthContext";
import LinkNoticeBanner from "../../layout/LinkNoticeBanner";
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

/** The card every screen before the app sits on: the mark, a title and one
 * line on what to do, a notice above the screen's own content, and a footer.
 * Needs no session, so a page outside the app's session, such as the one
 * Switch Console's sign-in link opens, uses it too. */
export function AuthCard({
  title,
  subtitle,
  notice,
  children,
  footer,
}: {
  title: string;
  subtitle: ReactNode;
  notice: ReactNode;
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
        {notice}
        {children}
        {footer !== null && (
          <Box sx={{ mt: 3, textAlign: "center" }}>{footer}</Box>
        )}
      </Card>
    </Backdrop>
  );
}

/** The layout of every screen shown before the app inside its session:
 * signing in, accepting an invitation, choosing a workspace, and creating
 * one. `AuthCard`, with the notice a link naming a workspace leaves. */
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
    <AuthCard title={title} subtitle={subtitle} notice={<LinkNoticeBanner />} footer={footer}>
      {children}
    </AuthCard>
  );
}

/** Who is signed in, and the way out: for the screens a signed-in person sees
 * before they are in a workspace. */
export function SignedInFooter() {
  const { user, logout } = useAuth();
  // A sign-out that works leaves this screen; one that fails says so.
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const signOut = async () => {
    setSignOutError(null);
    try {
      await logout();
    } catch (err) {
      setSignOutError(`Couldn't sign out: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return (
    <>
      <Typography variant="body2" sx={{ color: "text.secondary", overflowWrap: "anywhere" }}>
        {user ? `Signed in as ${user.email} · ` : ""}
        <Link
          component="button"
          type="button"
          onClick={() => void signOut()}
          color="inherit"
          sx={{ verticalAlign: "baseline" }}
        >
          Sign out
        </Link>
      </Typography>
      {signOutError && (
        <Alert severity="error" sx={{ mt: 2, overflowWrap: "anywhere", textAlign: "left" }}>
          {signOutError}
        </Alert>
      )}
    </>
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
