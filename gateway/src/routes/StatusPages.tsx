import { Alert, Button, Stack, Typography } from "@mui/material";
import { Link as RouterLink } from "react-router";
import type { Access } from "../data/capabilities";
import { useAuth } from "../data/AuthContext";
import { howToTurnOn } from "../data/featureFlags";

type Refusal = Exclude<Access, { allowed: true }>;

/** What someone sees in place of a page they may not open, or one this
 * server does not run, instead of the page loading and the API refusing it
 * piece by piece. */
export function NoAccessPage({ access }: { access: Refusal }) {
  const { isOperator } = useAuth();
  return (
    <Stack spacing={2} sx={{ maxWidth: 560 }}>
      <Typography variant="h5">
        {access.reason === "not_enabled" ? "Not turned on" : "You don't have access to this page"}
      </Typography>
      <Typography>{access.message}</Typography>
      {access.reason === "not_enabled" && isOperator && (
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {howToTurnOn(access.flag)}
        </Typography>
      )}
      <div>
        <Button component={RouterLink} to="/" variant="outlined">
          Go to the start page
        </Button>
      </div>
    </Stack>
  );
}

export function NotFoundPage() {
  return (
    <Stack spacing={2} sx={{ maxWidth: 560 }}>
      <Typography variant="h5">There's no page here</Typography>
      <Typography>The address may be mistyped, or the page may have moved.</Typography>
      <div>
        <Button component={RouterLink} to="/" variant="outlined">
          Go to the start page
        </Button>
      </div>
    </Stack>
  );
}

/** A page of the new layout that is not built yet. Only a server with the
 * new layout turned on shows it, and that is meant for development and
 * staging until every page is in. */
export function PlannedPage({ title }: { title: string }) {
  return (
    <Stack spacing={2}>
      <Typography variant="h5">{title}</Typography>
      <Alert severity="info">This page is part of the new layout and isn't built yet.</Alert>
    </Stack>
  );
}
