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
  muted = false,
  action,
}: {
  icon: ReactNode;
  choice: ConnectChoice;
  badge?: string;
  /** Shown but not offered here: its app is not set up. */
  muted?: boolean;
  action: ReactNode;
}) {
  return (
    <Card
      variant="outlined"
      component="section"
      aria-label={choice.title}
      sx={{ display: "flex", bgcolor: muted ? "action.hover" : undefined }}
    >
      <CardContent sx={{ display: "flex", flexDirection: "column", gap: 1.5, flex: 1 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", opacity: muted ? 0.75 : 1 }}>
          {icon}
          <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
            {choice.title}
          </Typography>
          {badge && <Chip size="small" variant={muted ? "outlined" : "filled"} label={badge} />}
        </Stack>
        <Stack
          component="ul"
          spacing={1}
          sx={{ m: 0, p: 0, listStyle: "none", flex: 1, opacity: muted ? 0.75 : 1 }}
        >
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
  setUp,
}: {
  connection: ServiceConnection;
  leaving: boolean;
  onSignIn: () => void;
  onToken: () => void;
  /** Where the operator sets up the app this server lacks; null for anyone else. */
  setUp: ReactNode;
}) {
  const choices = CONNECT_CHOICES[connection.slug];
  if (!choices) return null;
  // The sign-in waits on an app this server lacks: shown, so people know it
  // exists and who can turn it on, with the token as the way in meanwhile.
  const signInBlocked = connection.sign_in_unavailable_reason;
  return (
    <Stack spacing={1.5} component="section" aria-label={`Connect ${connection.name}`}>
      <Typography variant="h6" component="h2">
        Connect {connection.name}
      </Typography>
      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>
        {signInBlocked ? (
          <Choice
            icon={<VerifiedUserOutlined fontSize="small" aria-hidden />}
            choice={choices.signIn}
            badge={connection.server_setup_needed ? "Not set up here" : "Not available here"}
            muted
            action={
              setUp ?? (
                <Typography variant="body2" color="text.secondary">
                  {signInBlocked}
                </Typography>
              )
            }
          />
        ) : (
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
        )}
        <Choice
          icon={<KeyOutlined fontSize="small" aria-hidden />}
          choice={
            signInBlocked
              ? {
                  ...choices.token,
                  points: ["Works now, with nothing else to set up", ...choices.token.points.slice(1)],
                }
              : choices.token
          }
          badge={signInBlocked ? "Available now" : undefined}
          action={
            <Button variant={signInBlocked ? "contained" : "outlined"} onClick={onToken} disabled={leaving}>
              Use a token
            </Button>
          }
        />
      </Box>
    </Stack>
  );
}
