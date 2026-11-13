import DeleteOutline from "@mui/icons-material/DeleteOutline";
import {
  Alert,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  MenuItem,
  Select,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DataTable, { TableEmptyState } from "../../components/DataTable";
import { useAuth } from "../../data/AuthContext";
import {
  type OrganizationMember,
  type OrganizationRole,
  fetchOrganizationMembers,
  needsOrganizationSignIn,
  organizationSignInUrl,
  removeOrganizationMember,
  signInAfterAccessEnded,
  updateOrganizationRole,
} from "../../data/api";
import { formatDate } from "../../theme/format";
import { useLoad } from "../workspace/useLoad";

type MemberRow = OrganizationMember & { id: string };

const ROLE_LABELS: Record<OrganizationRole, string> = {
  org_admin: "Org admin",
  member: "Member",
};

/** A change kept across the sign-in to the organization's WorkOS account it
 * waited on, made again once, on coming back: only in the organization it was
 * made in, and only while the sign-in it waited on could still be coming back
 * (the server keeps a started sign-in for ten minutes). */
type MemberChange = { userId: string; role: OrganizationRole } | { userId: string; remove: true };
type PendingChange = { change: MemberChange; organizationId: string; savedAt: number };
const PENDING_CHANGE_KEY = "switch.pendingOrganizationMemberChange";
const PENDING_CHANGE_TTL_MS = 10 * 60 * 1000;

function make(change: MemberChange): Promise<{ warning: string | null }> {
  return "remove" in change
    ? removeOrganizationMember(change.userId)
    : updateOrganizationRole(change.userId, change.role);
}

function signInThenMake(change: MemberChange, organizationId: string): void {
  const pending: PendingChange = { change, organizationId, savedAt: Date.now() };
  window.sessionStorage.setItem(PENDING_CHANGE_KEY, JSON.stringify(pending));
  window.location.href = organizationSignInUrl(window.location.pathname);
}

function takePendingChange(organizationId: string): MemberChange | null {
  const kept = window.sessionStorage.getItem(PENDING_CHANGE_KEY);
  window.sessionStorage.removeItem(PENDING_CHANGE_KEY);
  if (kept === null) return null;
  try {
    const pending = JSON.parse(kept) as PendingChange;
    if (
      pending.organizationId !== organizationId ||
      typeof pending.savedAt !== "number" ||
      Date.now() - pending.savedAt > PENDING_CHANGE_TTL_MS
    ) {
      return null;
    }
    return pending.change;
  } catch {
    return null;
  }
}

/** Everyone in the organization, across its workspaces, and their role in it.
 * Each row offers what the server says the caller may do with it: never their
 * own row, which another organization admin changes. The server refuses
 * demoting or removing the last organization admin, and removing someone
 * still in one of its workspaces, naming them; its message is shown as is. Demoting or removing an admin also takes away their keys and
 * connections in workspaces they were in only as an admin; what could not be
 * revoked at a vendor comes back as a warning, shown too. */
export default function OrganizationMembersSection({
  selfId,
  organizationId,
  asOperator,
  canManage,
  fromDirectory,
  directoryTakesChanges,
  onChanged,
}: {
  selfId: string;
  organizationId: string;
  // The platform operator, who is no admin here, may manage the members only
  // while the organization has no admin left, to make one.
  asOperator: boolean;
  // The server's `can_manage_members`: whether this person may list and
  // manage the members at all. The operator is not asked for them where not.
  canManage: boolean;
  // The members come from the organization's account settings: nobody can be
  // made Org Admin here, and what is taken away here comes back while those
  // settings still grant it.
  fromDirectory: boolean;
  // Changes made here are made in those account settings too, so they last
  // and Org Admin can be given here; the admin may first be sent to sign in
  // there, and the change is made on coming back.
  directoryTakesChanges: boolean;
  // Called after each change that went through.
  onChanged: () => void;
}) {
  const lockedOut = asOperator && !canManage;
  const load = useCallback(
    () => (lockedOut ? Promise.resolve(null) : fetchOrganizationMembers()),
    [lockedOut],
  );
  const { data: members, error, errorStatus, loading, refetch } = useLoad(load);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionWarning, setActionWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // A change that ended someone's workspace access and then asked for a
  // sign-in, for the admin to finish knowingly.
  const [toFinish, setToFinish] = useState<MemberChange | null>(null);
  const { refresh } = useAuth();

  const act = useCallback(
    async (change: MemberChange, replayed = false) => {
      setBusy(change.userId);
      setActionError(null);
      setActionWarning(null);
      setToFinish(null);
      try {
        const { warning } = await make(change);
        setActionWarning(warning);
        onChanged();
        if (change.userId === selfId) {
          // Your own role decides what this page offers you. Stepping down or
          // leaving takes away reading these members at all, and may move the
          // session to another workspace; the page follows it.
          await refresh();
          if ("remove" in change || change.role !== "org_admin") return;
        }
        await refetch();
      } catch (err) {
        // Once only: a change made again after the sign-in that still asks
        // for one is shown as the failure it is, not sent round again. The
        // operator is no member there and has nothing to sign in as.
        // A change that already took something away says so first.
        if (needsOrganizationSignIn(err) && !replayed && !asOperator) {
          if (!signInAfterAccessEnded(err)) {
            signInThenMake(change, organizationId);
            return;
          }
          setToFinish(change);
        }
        setActionError(err instanceof Error ? err.message : "The change failed");
      } finally {
        setBusy(null);
      }
    },
    [asOperator, onChanged, organizationId, refetch, refresh, selfId],
  );

  const replayed = useRef(false);
  useEffect(() => {
    if (replayed.current) return;
    replayed.current = true;
    const pending = takePendingChange(organizationId);
    if (pending !== null) void act(pending, true);
  }, [act, organizationId]);

  const columns = useMemo<GridColDef<MemberRow>[]>(
    () => [
      {
        field: "name",
        headerName: "Name",
        flex: 1,
        minWidth: 140,
        renderCell: ({ row }) => (row.user_id === selfId ? `${row.name} (you)` : row.name),
      },
      { field: "email", headerName: "Email", flex: 1.5, minWidth: 200 },
      {
        field: "role",
        headerName: "Organization role",
        width: 170,
        renderCell: ({ row }) =>
          row.can_change_role ? (
            <Select
              size="small"
              value={row.role}
              disabled={busy !== null}
              onChange={(e) =>
                act({ userId: row.user_id, role: e.target.value as OrganizationRole })
              }
              // The name goes on the input: on the Select it labels nothing.
              inputProps={{ "aria-label": `Organization role for ${row.email}` }}
              sx={{ fontSize: "0.875rem" }}
            >
              {(Object.keys(ROLE_LABELS) as OrganizationRole[]).map((role) => (
                <MenuItem
                  key={role}
                  value={role}
                  disabled={
                    role === "org_admin" && row.role !== "org_admin" && !row.can_grant_org_admin
                  }
                >
                  {ROLE_LABELS[role]}
                </MenuItem>
              ))}
            </Select>
          ) : (
            <Chip
              label={ROLE_LABELS[row.role]}
              size="small"
              color={row.role === "org_admin" ? "primary" : "default"}
            />
          ),
      },
      {
        field: "created_at",
        headerName: "Joined",
        width: 140,
        valueFormatter: (value) => formatDate(value as string),
      },
      {
        field: "actions",
        headerName: "",
        width: 60,
        sortable: false,
        renderCell: ({ row }) =>
          row.can_remove ? (
            <Tooltip
              title={row.user_id === selfId ? "Leave organization" : "Remove from organization"}
            >
              <span>
                <IconButton
                  size="small"
                  disabled={busy !== null}
                  onClick={() => act({ userId: row.user_id, remove: true })}
                  aria-label={
                    row.user_id === selfId
                      ? "Leave this organization"
                      : `Remove ${row.email} from the organization`
                  }
                >
                  <DeleteOutline fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          ) : null,
      },
    ],
    [act, busy, selfId],
  );
  // Nothing to offer when nobody may be removed, as for the operator, who
  // restores an admin and nothing more.
  const shown = (members ?? []).some((m) => m.can_remove)
    ? columns
    : columns.filter((c) => c.field !== "actions");

  return (
    <Stack spacing={1.5}>
      <Typography variant="h6">Users</Typography>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        Organization admins administer every workspace in the organization. Someone is removed
        from each workspace before they can be removed from the organization.
      </Typography>
      {lockedOut || (asOperator && errorStatus === 403) ? (
        <Alert severity="info">
          As platform operator you can manage this organization's users only while it has no
          admin, to make someone one.
        </Alert>
      ) : (
        error && <Alert severity="error">{error}</Alert>
      )}
      {asOperator && !lockedOut && !error && !loading && (
        <Alert severity="warning">
          {fromDirectory
            ? "This organization has no admin. Its admins come from its account settings, so " +
              "someone has to be made an organization admin there."
            : "This organization has no admin. As platform operator you can make one of its " +
              "users an admin; the change is recorded in its audit log, marked as yours."}
        </Alert>
      )}
      {fromDirectory && directoryTakesChanges && !asOperator && (
        <Alert severity="info">
          This organization's users, and who is its admin, come from your organization's
          account settings. Changes you make here are made there too; you may be asked to
          confirm your sign-in there first. New people can't be added from here yet: add them
          there.
        </Alert>
      )}
      {fromDirectory && !directoryTakesChanges && !asOperator && (
        <Alert severity="info">
          This organization's users, and who is its admin, come from your organization's
          account settings. Add people and make someone an organization admin there; the change
          shows here shortly. Removing someone here, or making an admin a member, takes effect at
          once but lasts only while the account settings agree: they are read again at the
          person's next sign-in and once a day. Make the same change there to keep it.
        </Alert>
      )}
      {actionError && (
        <Alert
          severity="error"
          onClose={() => {
            setActionError(null);
            setToFinish(null);
          }}
          action={
            toFinish && (
              <Button
                color="inherit"
                size="small"
                onClick={() => signInThenMake(toFinish, organizationId)}
              >
                Confirm sign-in to finish
              </Button>
            )
          }
        >
          {actionError}
        </Alert>
      )}
      {actionWarning && (
        <Alert severity="warning" onClose={() => setActionWarning(null)}>
          {actionWarning}
        </Alert>
      )}
      {loading ? (
        <CircularProgress />
      ) : error || lockedOut ? null : (
        <DataTable
          rows={(members ?? []).map((m) => ({ ...m, id: m.user_id }))}
          columns={shown}
          emptyState={<TableEmptyState title="No users in this organization yet" />}
          height={Math.min(520, 108 + (members?.length ?? 0) * 52)}
          pageSize={25}
        />
      )}
    </Stack>
  );
}
