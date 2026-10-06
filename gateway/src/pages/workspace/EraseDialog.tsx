import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { type Person, eraseIdentities } from "../../data/api";

/** The identities that are probably the same person as `person`: every one
 * claimed by a member who also claims `person`. */
export function relatedIdentities(person: Person, people: Person[]): Person[] {
  const claimants = new Set(person.claimed_by.map((c) => c.user_id));
  if (claimants.size === 0) return [];
  return people.filter(
    (other) =>
      other.external_user_id !== person.external_user_id &&
      other.claimed_by.some((c) => claimants.has(c.user_id)),
  );
}

function plural(count: number, word: string): string {
  return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}

interface Props {
  tenantId: string;
  person: Person | null;
  people: Person[];
  onClose: () => void;
  onQueued: () => void;
}

export default function EraseDialog({ tenantId, person, people, onClose, onQueued }: Props) {
  const related = useMemo(
    () => (person ? relatedIdentities(person, people) : []),
    [person, people],
  );
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [typed, setTyped] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIncluded(new Set(related.map((p) => p.external_user_id)));
    setTyped("");
    setError(null);
  }, [person, related]);

  if (!person) return null;

  const chosen = [person, ...related.filter((p) => included.has(p.external_user_id))];
  const messages = chosen.reduce((sum, p) => sum + p.message_count, 0);
  const confirmed = typed === person.username;

  const toggle = (id: string) =>
    setIncluded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await eraseIdentities(
        tenantId,
        chosen.map((p) => p.external_user_id),
      );
      onQueued();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the erasure");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Erase {person.username}?</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <DialogContentText>
            This permanently deletes {plural(messages, "message")} they sent in every room of
            this workspace, archived rooms included, with their files and their identity. It
            cannot be undone.
          </DialogContentText>
          <DialogContentText>
            What other people wrote, including replies that quote them, is kept. Copies in{" "}
            {person.bridge_name} and other chat apps are not deleted; remove those in the app.
            Their Switch account and membership, if any, are not affected.
          </DialogContentText>
          {related.length > 0 && (
            <Stack spacing={0.5}>
              <Typography variant="subtitle2">
                Also claimed by {person.claimed_by.map((c) => c.name).join(", ")}:
              </Typography>
              {related.map((other) => (
                <FormControlLabel
                  key={other.external_user_id}
                  control={
                    <Checkbox
                      checked={included.has(other.external_user_id)}
                      onChange={() => toggle(other.external_user_id)}
                    />
                  }
                  label={`${other.username} on ${other.bridge_name} (${plural(other.message_count, "message")})`}
                />
              ))}
            </Stack>
          )}
          <TextField
            label={`Type ${person.username} to confirm`}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            fullWidth
          />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          color="error"
          variant="contained"
          disabled={!confirmed || submitting}
          onClick={() => void submit()}
        >
          Erase
        </Button>
      </DialogActions>
    </Dialog>
  );
}
