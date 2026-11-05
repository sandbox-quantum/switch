import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { type DeleteAgentResult, deleteAgent } from "../../../data/api";
import { listCloudLogins, waitForOperation, withdrawCloudLogin } from "../../../data/cloudLogins";
import { fetchManagedAgents } from "../../../data/management";
import { type DeletePlan, deletePlan } from "./cloudDelete";

/** Fixed words for why nothing was deleted: never the server's or the box's own text. */
export const NOT_DELETED = {
  withdraw:
    "The agent wasn't deleted: its AI login couldn't be taken off your cloud first. Try again, or withdraw the login from AI logins on your cloud.",
  read: "The agent wasn't deleted: Switch couldn't check who else uses its login. Try again.",
  delete: "The login was withdrawn, but the agent couldn't be deleted. Try deleting it again.",
} as const;

async function freshPlan(agentId: string, controllerId: string): Promise<DeletePlan> {
  const [agents, logins] = await Promise.all([fetchManagedAgents(), listCloudLogins(controllerId)]);
  return deletePlan(agentId, controllerId, agents, logins);
}

/**
 * Delete a cloud agent from Switch web (hosted agents v2, slice 5). Its box's
 * login for the agent's provider is withdrawn first, and only when no other
 * agent on the box uses it; otherwise the login stays and the confirm says who
 * still uses it. The plan is read fresh when the dialog opens and again at the
 * moment of confirming. The withdraw is read back (the login gone from the
 * box's list) before anything is deleted; if it fails, nothing is deleted.
 */
export default function CloudDeleteDialog({
  agent,
  controllerId,
  onClose,
  onDeleted,
}: {
  /** The agent to delete, or null when closed. */
  agent: { id: string; name: string } | null;
  /** The box's controller, from hosted-machines' `controller_id`. */
  controllerId: string;
  onClose: () => void;
  onDeleted: (result: DeleteAgentResult) => void;
}) {
  const [plan, setPlan] = useState<DeletePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const follow = useRef<AbortController | null>(null);

  useEffect(() => {
    setPlan(null);
    setError(null);
    if (!agent) return;
    let live = true;
    freshPlan(agent.id, controllerId).then(
      (next) => live && setPlan(next),
      () => live && setError(NOT_DELETED.read),
    );
    return () => {
      live = false;
      follow.current?.abort();
    };
  }, [agent, controllerId]);

  const confirm = async () => {
    if (!agent) return;
    setBusy(true);
    setError(null);
    follow.current = new AbortController();
    try {
      // Read again now: another agent may have been added or removed since it opened.
      let now: DeletePlan;
      try {
        now = await freshPlan(agent.id, controllerId);
      } catch {
        setError(NOT_DELETED.read);
        return;
      }
      setPlan(now);
      if (now.kind === "withdraw_then_delete") {
        const since = Date.now();
        try {
          const { controllerId: box } = await withdrawCloudLogin(now.provider);
          await waitForOperation(
            box,
            { kind: "provider.recheck", provider: now.provider, since },
            { signal: follow.current.signal },
          );
          if (follow.current.signal.aborted) return;
          // The read-back: the login must be gone from the box before the agent goes.
          const left = await listCloudLogins(controllerId);
          if (left.some((login) => login.provider === now.provider)) throw new Error("still there");
        } catch {
          setError(NOT_DELETED.withdraw);
          return;
        }
      }
      const result = await deleteAgent(agent.id);
      if (result === null) {
        setError(now.kind === "withdraw_then_delete" ? NOT_DELETED.delete : "The agent couldn't be deleted.");
        return;
      }
      onDeleted(result);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={agent !== null} onClose={busy ? undefined : onClose}>
      <DialogTitle>Delete {agent?.name}?</DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 1 }}>
            {error}
          </Alert>
        )}
        <DialogContentText data-testid="delete-plan">
          {plan === null
            ? "Checking which agents on your cloud use its AI login…"
            : plan.kind === "withdraw_then_delete"
              ? "It's the last agent on your cloud using this AI login, so the login is taken off your cloud first, then the agent is deleted."
              : plan.kind === "delete_keep_login"
                ? `The AI login stays on your cloud, because ${plan.sharedWith.join(", ")} still ${plan.sharedWith.length === 1 ? "uses" : "use"} it.`
                : plan.kind === "delete_only"
                  ? "The agent is stopped and deleted from your cloud."
                  : "This agent isn't on your cloud any more."}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          color="error"
          variant="contained"
          onClick={confirm}
          disabled={busy || plan === null || plan.kind === "not_found"}
          startIcon={busy ? <CircularProgress size={16} /> : undefined}
        >
          Delete
        </Button>
      </DialogActions>
    </Dialog>
  );
}
