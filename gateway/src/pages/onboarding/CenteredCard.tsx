import { Box, Button, Card, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";
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
  return (
    <Box
      sx={{
        display: "flex",
        minHeight: "100vh",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "var(--hoot-canvas)",
        py: 4,
      }}
    >
      <Card sx={{ width: 420, p: 4, boxShadow: "var(--hoot-shadow-surface)" }}>
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
          <Button size="small" color="inherit" onClick={logout}>
            Sign out
          </Button>
        </Stack>
      </Card>
    </Box>
  );
}
