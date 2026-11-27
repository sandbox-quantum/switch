import "@switch-console/chat-ui/theme.css";
import { Alert } from "@switch-console/chat-ui/primitives/alert";
import { Button } from "@switch-console/chat-ui/primitives/button";
import { Field } from "@switch-console/chat-ui/primitives/field";
import { Input } from "@switch-console/chat-ui/primitives/input";
import { Label } from "@switch-console/chat-ui/primitives/label";
import { Spinner } from "@switch-console/chat-ui/primitives/spinner";
import { useState } from "react";
import { createTenant } from "../../data/api";

export default function CreateWorkspaceForm({
  landing,
  onCancel,
}: {
  landing?: string;
  onCancel?: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createTenant(name.trim());
      window.location.assign(landing ?? "/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the organization");
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert variant="destructive">{error}</Alert>}
      <Field>
        <Label htmlFor="org-name">Organization name</Label>
        <Input
          id="org-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. your company or team"
          required
          autoFocus
        />
        <p className="mt-1 text-xs text-muted-foreground">
          It starts with one workspace of the same name. You can add more later.
        </p>
      </Field>
      <div className="flex gap-2">
        <Button
          type="submit"
          className="flex-1"
          disabled={submitting || name.trim() === ""}
        >
          {submitting && <Spinner className="size-4" />}
          Create organization
        </Button>
        {onCancel && (
          <Button variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
