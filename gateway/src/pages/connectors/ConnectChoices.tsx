import KeyOutlined from "@mui/icons-material/KeyOutlined";
import VerifiedUserOutlined from "@mui/icons-material/VerifiedUserOutlined";
import { Box, Button, Card, CardContent, Chip, CircularProgress, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";
import type { ServiceConnection } from "../../data/api";
import { CONNECT_CHOICES, type ConnectChoice } from "./connectorProfile";

function Choice({
  icon,
  choice,
  badge,
  action,
}: {
  icon: ReactNode;
  choice: ConnectChoice;
  badge?: string;
  action: ReactNode;
}) {
  return (
    <Card variant="outlined" component="section" aria-label={choice.title} sx={{ display: "flex" }}>
      <CardContent sx={{ display: "flex", flexDirection: "column", gap: 1.5, flex: 1 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          {icon}
          <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
            {choice.title}
          </Typography>
          {badge && <Chip size="small" label={badge} />}
        </Stack>
        <Stack component="ul" spacing={1} sx={{ m: 0, p: 0, listStyle: "none", flex: 1 }}>
          {choice.points.map((point) => (
            <Stack component="li" key={point} direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
              <Typography variant="body2" color="text.secondary" aria-hidden>
                •
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {point}
              </Typography>
            </Stack>
          ))}
        </Stack>
        <Box>{action}</Box>
      </CardContent>
    </Card>
  );
}

/** Whether the page sets this service's ways of connecting side by side. */
export function offersChoices(connection: ServiceConnection): boolean {
  return connection.slug in CONNECT_CHOICES && connection.paste.some((way) => way.method === "token");
}

/**
 * Connecting a service that has both a sign-in and a token in its place,
 * with what each means set side by side, since they differ in who agents
 * act as and who can end their access.
 */
export default function ConnectChoices({
  connection,
  leaving,
  onSignIn,
  onToken,
}: {
  connection: ServiceConnection;
  leaving: boolean;
  onSignIn: () => void;
  onToken: () => void;
}) {
  const choices = CONNECT_CHOICES[connection.slug];
  if (!choices) return null;
  return (
    <Stack spacing={1.5} component="section" aria-label={`Connect ${connection.name}`}>
      <Typography variant="h6" component="h2">
        Connect {connection.name}
      </Typography>
      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>
        <Choice
          icon={<VerifiedUserOutlined fontSize="small" aria-hidden />}
          choice={choices.signIn}
          badge="Recommended"
          action={
            <Button
              variant="contained"
              onClick={onSignIn}
              disabled={leaving}
              startIcon={leaving ? <CircularProgress size={16} color="inherit" /> : undefined}
            >
              Sign in with {connection.name}
            </Button>
          }
        />
        <Choice
          icon={<KeyOutlined fontSize="small" aria-hidden />}
          choice={choices.token}
          action={
            <Button variant="outlined" onClick={onToken} disabled={leaving}>
              Use a token
            </Button>
          }
        />
      </Box>
    </Stack>
  );
}
