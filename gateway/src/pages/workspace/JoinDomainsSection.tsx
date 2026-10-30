import {
  Alert,
  Button,
  CircularProgress,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { useCallback, useState } from "react";
import { addJoinDomain, fetchJoinDomains, removeJoinDomain } from "../../data/api";
import { useLoad } from "./useLoad";

/**
 * The e-mail domains anyone may join the workspace from, as a member, without
 * an invitation. Workspace admins only.
 *
 * The one domain on offer is the admin's own: that is the domain their
 * signed-in address proves they belong to, and the server refuses any other.
 * It also refuses a public provider's domain, and its reason is shown in place
 * of the button.
 */
export default function JoinDomainsSection({ tenantId }: { tenantId: string }) {
  const load = useCallback(() => fetchJoinDomains(tenantId), [tenantId]);
  const { data, error, loading, refetch } = useLoad(load);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const change = useCallback(
    async (domain: string, action: "add" | "remove") => {
      setBusy(domain);
      setActionError(null);
      try {
        if (action === "add") await addJoinDomain(tenantId, domain);
        else await removeJoinDomain(tenantId, domain);
        await refetch();
      } catch (err) {
        const fallback =
          action === "add"
            ? `Could not open the workspace to ${domain}.`
            : `Could not close the workspace to ${domain}.`;
        setActionError(err instanceof Error ? err.message : fallback);
      } finally {
        setBusy(null);
      }
    },
    [refetch, tenantId],
  );

  const ownOpen = data !== null && data.domains.some((d) => d.domain === data.own_domain);

  return (
    <Stack spacing={1.5}>
      <Typography variant="h6">Joining by e-mail domain</Typography>
      {loading ? (
        <CircularProgress size={24} />
      ) : error ? (
        <Alert severity="error">{error}</Alert>
      ) : (
        data && (
          <>
            {data.domains.length > 0 && (
              <Paper variant="outlined">
                <List dense disablePadding>
                  {data.domains.map(({ domain }) => (
                    <ListItem
                      key={domain}
                      divider
                      secondaryAction={
                        <Button
                          size="small"
                          color="error"
                          disabled={busy !== null}
                          onClick={() => void change(domain, "remove")}
                        >
                          {busy === domain ? "Removing…" : "Remove"}
                        </Button>
                      }
                    >
                      <ListItemText
                        primary={`Anyone with an @${domain} address can join as a member`}
                      />
                    </ListItem>
                  ))}
                </List>
              </Paper>
            )}
            {!ownOpen &&
              (data.own_domain_refusal !== null ? (
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  {data.own_domain_refusal}.
                </Typography>
              ) : (
                <Stack direction="row" spacing={2} alignItems="center">
                  <Typography variant="body2" sx={{ color: "text.secondary", flex: 1 }}>
                    Let anyone with an @{data.own_domain} address join as a member, without an
                    invitation.
                  </Typography>
                  <Button
                    variant="outlined"
                    size="small"
                    disabled={busy !== null}
                    onClick={() => void change(data.own_domain, "add")}
                  >
                    {busy === data.own_domain ? "Allowing…" : "Allow"}
                  </Button>
                </Stack>
              ))}
          </>
        )
      )}
      {actionError && (
        <Alert severity="error" onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      )}
    </Stack>
  );
}
