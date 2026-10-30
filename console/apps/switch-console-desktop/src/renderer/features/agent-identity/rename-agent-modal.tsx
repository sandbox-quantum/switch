import { useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import type { AgentRenameOutcome } from '@shared/core/switch-servers/switch-servers';
import { labelFollowsName, labelFromName } from './agent-label';
import { agentNamesChanged } from './agent-names-changed';

// The server's own rule, checked here only to say so before a round trip.
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

type RenameAgentModalArgs = {
  workspaceId: string;
  /** The agent's id on its Switch server. */
  switchAgentId: string;
  currentName: string;
  currentDisplayName: string | null;
  /** A Console agent's local id, whose files follow the new name; null for
   * an agent another machine runs. */
  localAgentId: string | null;
};

export type RenameAgentResult = {
  outcome: AgentRenameOutcome;
  /** Set when the server renamed the agent but Console could not follow
   * locally, with what to tell the person. */
  localProblem: string | null;
};

type Props = BaseModalProps<RenameAgentResult> & RenameAgentModalArgs;

/**
 * Rename an agent: its name, which people type to mention it, and its display
 * name, which they read, in one step. The display name follows the name while
 * it is the name written out and nobody has edited it here.
 */
export function RenameAgentModal({
  workspaceId,
  switchAgentId,
  currentName,
  currentDisplayName,
  localAgentId,
  onSuccess,
  onClose,
}: Props) {
  const follows = labelFollowsName(currentDisplayName, currentName);
  const [name, setName] = useState(currentName);
  const [displayName, setDisplayName] = useState(currentDisplayName ?? '');
  const [labelEdited, setLabelEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const trimmedLabel = displayName.trim();
  const unchanged = trimmedName === currentName && trimmedLabel === (currentDisplayName ?? '');
  const badName = trimmedName !== '' && !NAME_PATTERN.test(trimmedName);
  const suggested = follows && !labelEdited && trimmedName !== currentName;
  const canSubmit = !unchanged && trimmedName !== '' && !badName && !submitting;

  const changeName = (value: string) => {
    setName(value);
    setError(null);
    if (follows && !labelEdited) setDisplayName(labelFromName(value.trim()));
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    let outcome: AgentRenameOutcome;
    try {
      outcome = await rpc.workspaces.renameAgent({
        workspaceId,
        agentId: switchAgentId,
        name: trimmedName,
        displayName: trimmedLabel || null,
      });
    } catch (failure) {
      setError(failureText(failure, 'The agent could not be renamed. Nothing changed.'));
      setSubmitting(false);
      return;
    }
    let localProblem: string | null = null;
    if (localAgentId !== null && outcome.agent.name !== currentName) {
      try {
        await rpc.agents.renameLocal({ agentId: localAgentId, newName: outcome.agent.name });
      } catch (failure) {
        localProblem = failureText(
          failure,
          'Switch Console could not move its own files for this agent to the new name.'
        );
      }
    }
    agentNamesChanged();
    onSuccess({ outcome, localProblem });
  };

  const submitOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void submit();
  };

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Rename agent</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <p className="mb-4 text-sm text-foreground-muted">
          The name is what people type to mention the agent; the display name is what they read. Its
          rooms, sessions and history stay with it, and connected chat platforms are updated too.
        </p>
        <FieldGroup>
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input
              aria-label="Name"
              value={name}
              onChange={(e) => changeName(e.target.value)}
              onKeyDown={submitOnEnter}
              className="font-mono"
              autoFocus
            />
            <p className={`mt-1 text-xs ${badName ? 'text-destructive' : 'text-foreground-muted'}`}>
              Lowercase letters, digits, dots, hyphens and underscores.
            </p>
          </Field>
          <Field>
            <FieldLabel>Display name</FieldLabel>
            <Input
              aria-label="Display name"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setLabelEdited(true);
                setError(null);
              }}
              onKeyDown={submitOnEnter}
            />
            <p className="mt-1 text-xs text-foreground-muted">
              {suggested
                ? 'Suggested from the new name. Change it if you like.'
                : 'Leave blank to show the name instead.'}
            </p>
          </Field>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </FieldGroup>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <ConfirmButton onClick={() => void submit()} disabled={!canSubmit}>
          {submitting ? 'Renaming…' : 'Rename'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}
