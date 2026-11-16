import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../data/AuthContext";
import {
  type OrganizationRole,
  needsOrganizationSignIn,
  organizationSignInUrl,
  removeOrganizationMember,
  signInAfterAccessEnded,
  updateOrganizationRole,
} from "../../data/api";

/** A change kept across the sign-in to the organization's WorkOS account it
 * waited on, made again once, on coming back: only in the organization it was
 * made in, and only while the sign-in it waited on could still be coming back
 * (the server keeps a started sign-in for ten minutes). */
export type MemberChange = { userId: string; role: OrganizationRole } | { userId: string; remove: true };
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


/** Making a change to an organization's members, the way both layouts' Users
 * do: where its members come from a directory that wants the admin's own
 * sign-in first, the admin is sent there and the change made again, once, on
 * coming back; a change that already took something away says so first, and
 * offers to finish. `onChanged` runs after each change that went through, and
 * `reload` reads the members again (not after the caller stepped down or
 * left, which takes reading them away). */
export function useMemberChanges({
  organizationId,
  selfId,
  asOperator,
  onChanged,
  reload,
}: {
  organizationId: string;
  selfId: string;
  // The operator is no member there and has nothing to sign in as.
  asOperator: boolean;
  onChanged: () => void;
  reload: () => Promise<void>;
}) {
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
        await reload();
      } catch (err) {
        // Once only: a change made again after the sign-in that still asks
        // for one is shown as the failure it is, not sent round again.
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
    [asOperator, onChanged, organizationId, reload, refresh, selfId],
  );

  const replayed = useRef(false);
  useEffect(() => {
    if (replayed.current) return;
    replayed.current = true;
    const pending = takePendingChange(organizationId);
    if (pending !== null) void act(pending, true);
  }, [act, organizationId]);

  return {
    act,
    busy,
    actionError,
    actionWarning,
    toFinish,
    /** Send the admin to sign in, then finish the change on coming back. */
    finish: () => toFinish !== null && signInThenMake(toFinish, organizationId),
    dismissError: () => {
      setActionError(null);
      setToFinish(null);
    },
    dismissWarning: () => setActionWarning(null),
  };
}
