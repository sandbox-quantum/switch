import { useState } from 'react';
import { createWorkspaceFailureText } from '@renderer/features/workspaces/describe-create-failure';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { WizardFrame } from '@renderer/lib/ui/wizard-frame';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import type { Workspace } from '@shared/core/workspaces/workspaces';

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
  /**
   * The workspace the server has already minted, when entering it is what
   * failed.
   *
   * Asking again would offer a name the server has just taken and come back
   * with a conflict that reads as the name being refused. On the page reached
   * with no memberships there is no Back either, so the only remaining move has
   * to be the one that can still work: entering what exists.
   */
  const [created, setCreated] = useState<Workspace | null>(null);

  const trimmed = name.trim();

  const submit = async () => {
    if (submitting || (created === null && trimmed === '')) return;
    setSubmitting(true);
    setError(null);
    try {
      const workspace = created ?? (await workspacesStore.create(server.id, trimmed));
      setCreated(workspace);
      await workspacesStore.setActive(workspace.id);
      onCreated();
    } catch (cause) {
      // Two different failures wear the same button. Before the workspace
      // exists the likeliest one is the name, and after it exists the name is
      // settled and what failed was the move into it — saying "could not
      // create" then would be describing the wrong step.
      setError(
        created === null
          ? createWorkspaceFailureText(
              cause,
              server.name,
              `${server.name} could not create the workspace.`
            )
          : failureText(cause, `This window could not be moved into ${created.name}.`)
      );
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
        onBack: onBack && !submitting && created === null ? onBack : null,
        onNext: null,
      }}
      footer={
        <>
          {onBack && created === null && (
            <Button variant="outline" onClick={onBack} disabled={submitting}>
              Back
            </Button>
          )}
          <ConfirmButton
            onClick={() => void submit()}
            disabled={submitting || (created === null && trimmed === '')}
          >
            {created !== null
              ? submitting
                ? 'Opening…'
                : 'Open workspace'
              : submitting
                ? 'Creating…'
                : 'Create workspace'}
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
            disabled={created !== null}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
          {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
          {created !== null && (
            <p className="mt-1 text-xs text-foreground-muted">
              {created.name} was created on {server.name}, but this window could not be moved into
              it. Try again — asking for it a second time would only be refused for the name it
              already has.
            </p>
          )}
        </Field>
      </FieldGroup>
    </WizardFrame>
  );
}
