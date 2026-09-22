import { useState } from 'react';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { WizardFrame } from '@renderer/lib/ui/wizard-frame';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

/**
 * Make the workspace the account will work in.
 *
 * A name and nothing else. The design's address hint under the field describes
 * a workspace reachable at its own subdomain, which is not how a Switch
 * workspace is addressed — it lives on the server you signed in to, and showing
 * an address that resolves to nothing would be the app inventing an answer. The
 * "let my team join automatically" toggle is gone for the same reason: joining
 * by email domain is a thing no Switch server can do yet, so a switch for it
 * would silently do nothing.
 */
export function CreateWorkspacePage({
  server,
  onBack,
  onCreated,
}: {
  server: SwitchServer;
  /** Null where the account is in no workspace, so there is no list behind this. */
  onBack: (() => void) | null;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();

  const submit = async () => {
    if (trimmed === '' || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const workspace = await workspacesStore.create(server.id, trimmed);
      await workspacesStore.setActive(workspace.id);
      onCreated();
    } catch (cause) {
      setError(failureText(cause, `${server.name} could not create the workspace.`));
      setSubmitting(false);
    }
  };

  return (
    <WizardFrame
      title="Create your workspace"
      subtitle={
        onBack === null
          ? `You’re not in a workspace on ${server.name} yet, so you’re the first one here. A workspace is where your agents, rooms and teammates live.`
          : 'A workspace is where your agents, rooms and teammates live.'
      }
      pager={{
        pageName: 'Create your workspace',
        onBack: onBack && !submitting ? onBack : null,
        onNext: null,
      }}
      footer={
        <>
          {onBack && (
            <Button variant="outline" onClick={onBack} disabled={submitting}>
              Back
            </Button>
          )}
          <ConfirmButton onClick={() => void submit()} disabled={trimmed === '' || submitting}>
            {submitting ? 'Creating…' : 'Create workspace'}
          </ConfirmButton>
        </>
      }
    >
      <FieldGroup>
        <Field>
          <FieldLabel>Name</FieldLabel>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Robotics"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
          {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
        </Field>
      </FieldGroup>
    </WizardFrame>
  );
}
