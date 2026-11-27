import { useEffect, useState } from "react";
import { Alert } from "@switch-console/chat-ui/primitives/alert";
import { Button } from "@switch-console/chat-ui/primitives/button";
import { Spinner } from "@switch-console/chat-ui/primitives/spinner";
import { type InvitationPreview, acceptInvitation, previewInvitation } from "../../data/api";
import { useAuth } from "../../data/AuthContext";
import { clearPendingInvite } from "../../data/sessionState";
import { workspaceRoleLabel } from "../workspace/roles";
import CenteredCard from "./CenteredCard";

/** "Join Acme in Acme Inc as Member": what the person is about to join,
 * before they accept. */
export function joinSentence(preview: InvitationPreview): string {
  const role = workspaceRoleLabel(preview.role);
  return preview.organization_name === null
    ? `Join ${preview.workspace_name} as ${role}`
    : `Join ${preview.workspace_name} in ${preview.organization_name} as ${role}`;
}

/** A signed-in person arriving with an invite token. The server reads the
 * token and says what it is to before they accept, and refuses one that
 * would not work, so they never accept blind. */
export default function AcceptInvitePage({ token }: { token: string }) {
  const { refresh } = useAuth();
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Accepting an invitation to a workspace they're already in at its role or
  // above changes nothing; the session is in that workspace either way.
  const [alreadyIn, setAlreadyIn] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let current = true;
    previewInvitation(token).then(
      (found) => {
        if (current) setPreview(found);
      },
      // Kept until they choose Continue, which drops it.
      (err: unknown) => {
        if (current) setError(err instanceof Error ? err.message : "Could not read the invitation");
      },
    );
    return () => {
      current = false;
    };
  }, [token]);

  // Accepting switches the session into the workspace, so success reloads
  // into it. Either way the token is spent from this tab: a failed one will
  // not succeed on a retry, and should not keep this screen in front of
  // everything else.
  const accept = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const joined = await acceptInvitation(token);
      clearPendingInvite();
      if (joined.already_member) {
        setAlreadyIn(
          `You're already in ${joined.name} as ${workspaceRoleLabel(joined.role)}, so nothing changed.`,
        );
        setSubmitting(false);
        return;
      }
      window.location.assign("/");
    } catch (err) {
      clearPendingInvite();
      setError(err instanceof Error ? err.message : "Could not accept the invitation");
      setSubmitting(false);
    }
  };

  const decline = async () => {
    clearPendingInvite();
    await refresh();
  };

  const subtitle =
    preview === null ? "You've been invited to a Switch workspace." : `${joinSentence(preview)}?`;

  return (
    <CenteredCard title="Join a workspace" subtitle={subtitle}>
      {alreadyIn !== null ? (
        <div className="flex flex-col gap-3">
          <Alert variant="info">{alreadyIn}</Alert>
          <Button onClick={() => window.location.assign("/")}>Open the workspace</Button>
        </div>
      ) : error ? (
        <div className="flex flex-col gap-3">
          <Alert variant="destructive">{error}</Alert>
          <Button variant="outline" onClick={decline}>
            Continue
          </Button>
        </div>
      ) : preview === null ? (
        <div className="flex items-center gap-2">
          <Spinner size="sm" />
          <span className="text-sm text-foreground-muted">Reading the invitation…</span>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button
            className="flex-1"
            onClick={accept}
            disabled={submitting}
          >
            {submitting && <Spinner size="sm" />}
            Accept invitation
          </Button>
          <Button variant="outline" onClick={decline} disabled={submitting}>
            Decline
          </Button>
        </div>
      )}
    </CenteredCard>
  );
}
