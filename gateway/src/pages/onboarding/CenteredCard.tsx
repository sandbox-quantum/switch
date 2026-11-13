import { Alert, Box, Button, Card, Stack, Typography } from "@mui/material";
import { type ReactNode, useState } from "react";
import { useAuth } from "../../data/AuthContext";

/** The layout the sign-in page uses, for the screens a signed-in person sees
 * before they are in a workspace. */
export default function CenteredCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: ReactNode;
  children: ReactNode;
}) {
  const { user, logout } = useAuth();
  // A sign-out that works leaves this screen; one that fails says so.
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const signOut = async () => {
    setSignOutError(null);
    try {
      await logout();
    } catch (err) {
      setSignOutError(`Could not sign out: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return (
    <Box
      sx={{
        display: "flex",
        minHeight: "100vh",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "var(--sw-canvas)",
        py: 4,
      }}
    >
      <Card sx={{ width: 420, p: 4, boxShadow: "var(--sw-shadow-surface)" }}>
        <Typography variant="h6" sx={{ mb: 0.5 }}>
          {title}
        </Typography>
        <Typography variant="body2" sx={{ mb: 3, color: "text.secondary" }}>
          {subtitle}
        </Typography>
        {children}
        <Stack
          direction="row"
          sx={{ mt: 3, alignItems: "center", justifyContent: "space-between" }}
        >
          <Typography variant="caption" sx={{ color: "text.secondary" }} noWrap>
            {user ? `Signed in as ${user.email}` : ""}
          </Typography>
          <Button size="small" color="inherit" onClick={() => void signOut()}>
            Sign out
          </Button>
        </Stack>
        {signOutError && (
          <Alert severity="error" sx={{ mt: 2, overflowWrap: "anywhere" }}>
            {signOutError}
          </Alert>
        )}
      </Card>
    </Box>
  );
}
