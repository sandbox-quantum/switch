import { Alert, Chip, CircularProgress, FormControlLabel, Stack, Switch, Typography } from "@mui/material";
import { useCallback, useEffect, useMemo, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog";
import DataTable, { type TableColumn, TableEmptyState } from "../../components/DataTable";
import RowActionsMenu from "../../components/RowActionsMenu";
import {
  type Invitation,
  type Member,
  fetchCurrentOrganization,
  fetchInvitations,
  revokeInvitation,
} from "../../data/api";
import { EM_DASH, formatDate } from "../../theme/format";
import { useInvitationCreated } from "./invitationEvents";
import { workspaceRoleLabel } from "./roles";
import { useLoad } from "./useLoad";

type LinkStatus = "Active" | "Revoked" | "Expired" | "Used";

export function invitationStatus(inv: Invitation, now: number): LinkStatus {
  if (inv.revoked_at) return "Revoked";
  if (new Date(inv.expires_at).getTime() <= now) return "Expired";
  if (inv.uses_remaining <= 0) return "Used";
  return "Active";
}

const PINNED_ACTIONS = ["actions"];

interface Props {
  tenantId: string;
  inOrganization: boolean;
  /** The roster, to name who made each link; null until it has loaded, or
   * when it could not be. */
  members: Member[] | null;
}

/** The workspace's invite links: the active ones, newest first, each
 * revocable; the ended ones on request. A link's token is shown once, when it
 * is made, so nothing here can show it again. Only an active link can be
 * revoked: the server refuses one that has already ended. */
export default function InviteLinksSection({ tenantId, inOrganization, members }: Props) {
  const load = useCallback(() => fetchInvitations(tenantId), [tenantId]);
  const { data: invitations, error, loading, refetch } = useLoad(load);
  useInvitationCreated(refetch);
  // Whether only people already in the organization can accept: where its
  // members come from its account settings, Switch can't add anyone new.
  const loadOrganization = useCallback(
    () => (inOrganization ? fetchCurrentOrganization() : Promise.resolve(null)),
    [inOrganization],
  );
  const { data: organization, error: organizationError } = useLoad(loadOrganization);
  const [showEnded, setShowEnded] = useState(false);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  // Re-evaluated on a timer so a link that expires while the page is open
  // stops showing as active.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const names = useMemo(
    () => (members === null ? null : new Map(members.map((m) => [m.user_id, m.name]))),
    [members],
  );
  const rows = useMemo(
    () =>
      (invitations ?? [])
        .filter((inv) => showEnded || invitationStatus(inv, now) === "Active")
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [invitations, showEnded, now],
  );

  const columns = useMemo<TableColumn<Invitation>[]>(
    () => [
      {
        field: "email",
        headerName: "For",
        flex: 1,
        minWidth: 200,
        valueFormatter: (value) => (value as string | null) ?? "Anyone with the link",
      },
      {
        field: "role",
        headerName: "Role",
        width: 160,
        valueFormatter: (value) => workspaceRoleLabel(value as Invitation["role"]),
      },
      ...(showEnded
        ? [
            {
              field: "status",
              headerName: "Status",
              width: 110,
              valueGetter: (_value, row) => invitationStatus(row, now),
              renderCell: ({ row }) => {
                const status = invitationStatus(row, now);
                return status === "Active" ? (
                  <Chip label={status} size="small" color="success" />
                ) : (
                  <Chip label={status} size="small" />
                );
              },
            } satisfies TableColumn<Invitation>,
          ]
        : []),
      { field: "uses_remaining", headerName: "Uses left", width: 100 },
      {
        field: "expires_at",
        headerName: "Expires",
        width: 130,
        valueFormatter: (value) => formatDate(value as string),
      },
      {
        field: "created_by",
        headerName: "Created by",
        width: 180,
        // Not known until the roster is: "no longer here" would be a guess.
        valueGetter: (value) =>
          names === null ? EM_DASH : (names.get(value as string) ?? "Someone no longer here"),
      },
      {
        field: "actions",
        headerName: "",
        width: 64,
        sortable: false,
        disableColumnMenu: true,
        renderCell: ({ row, tabIndex }) => (
          <RowActionsMenu
            label={`Actions for the link ${row.email === null ? "for anyone" : `for ${row.email}`}`}
            actions={
              invitationStatus(row, now) === "Active"
                ? [{ label: "Revoke link", destructive: true, onClick: () => setRevoking(row) }]
                : []
            }
            tabIndex={tabIndex}
          />
        ),
      },
    ],
    [names, now, showEnded],
  );

  const revoke = async (invitation: Invitation) => {
    await revokeInvitation(tenantId, invitation.id);
    await refetch();
  };

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" sx={{ alignItems: "flex-end", justifyContent: "space-between" }}>
        <Stack spacing={0.5}>
          <Typography variant="h6">Invite links</Typography>
          <Typography variant="body2" color="text.secondary">
            Anyone with an active link can join with its role. A link is shown only when it's
            created.
          </Typography>
        </Stack>
        <FormControlLabel
          control={<Switch checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} />}
          label="Show ended links"
          sx={{ mr: 0 }}
        />
      </Stack>
      {organization?.members_from_directory && (
        <Alert severity="info">
          This organization's users come from your organization's account settings, so only
          people already in the organization can accept an invitation. Add anyone new there
          first.
        </Alert>
      )}
      {organizationError && (
        <Alert severity="warning">
          Could not check who can accept an invitation here: {organizationError}
        </Alert>
      )}
      {error && <Alert severity="error">{error}</Alert>}
      {loading ? (
        <CircularProgress />
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          pinnedRight={PINNED_ACTIONS}
          emptyState={
            <TableEmptyState title={showEnded ? "No invite links yet" : "No active invite links"}>
              Invite users to make a link to this workspace.
            </TableEmptyState>
          }
          height={480}
          pageSize={25}
        />
      )}
      {revoking !== null && (
        <ConfirmDialog
          open
          title="Revoke this invite link?"
          description="It stops working at once. Anyone who has already joined with it stays."
          confirmLabel="Revoke"
          tone="destructive"
          onConfirm={() => revoke(revoking)}
          onClose={() => setRevoking(null)}
        />
      )}
    </Stack>
  );
}
