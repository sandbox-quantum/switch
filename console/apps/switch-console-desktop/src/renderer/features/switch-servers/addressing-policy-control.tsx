import { CircleAlert } from 'lucide-react';
import { useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { cn } from '@renderer/utils/utils';
import {
  type AddressingMode,
  addressingModeOf,
  policyForMode,
  policyNamesOwner,
} from '@shared/core/switch-servers/owner-policy';
import type { AddressingPolicy } from '@shared/core/switch-servers/switch-servers';
import { AddressingPolicyEditor, type OptionItem } from './addressing-policy-editor';

const MODE_ORDER: AddressingMode[] = ['owner', 'ownerAndAgents', 'anyone', 'custom'];

const MODE_LABELS: Record<AddressingMode, string> = {
  owner: 'Only me (default)',
  ownerAndAgents: 'Only me and my agents',
  anyone: 'Anyone',
  custom: 'Custom rules',
};

const MODE_HINTS: Record<AddressingMode, string> = {
  ownerAndAgents:
    'You, and any agent you own — so one of your agents can hand this one work. Nobody else.',
  owner: 'Only you, in person. Agents cannot send it instructions, including your own.',
  anyone: 'Anyone in this agent’s rooms can send it instructions.',
  custom: 'Rules say exactly who can send instructions, and in which rooms.',
};

/**
 * Who may address an agent, as one choice out of four (CHOO-2137).
 *
 * The three answers people actually want are each a policy shape rather than a
 * form to fill in; the rule editor stays available behind the fourth for
 * everything else. Shared by the creation modal and the agent's settings page
 * so a policy is changed the same way it was set.
 */
export function AddressingPolicyControl({
  value,
  onChange,
  rooms,
  roomGroups,
  users,
  agents,
  unlinkedApps,
  onOpenMessagingApps,
  inlineLabel,
  disabled = false,
}: {
  value: AddressingPolicy | null;
  onChange: (next: AddressingPolicy | null) => void;
  rooms: OptionItem[];
  roomGroups: OptionItem[];
  users: OptionItem[];
  agents: OptionItem[];
  /** Messaging apps on this server the signed-in user has claimed no account
   * on, by display name. An owner rule resolves through a claimed account, so
   * in those apps it admits nobody — and that is true of one unclaimed app even
   * when others are linked. Null while unknown; no warning is drawn from a list
   * that has not arrived. */
  unlinkedApps: string[] | null;
  /** Opens the server's Messaging apps, which is where an account is linked. */
  onOpenMessagingApps: () => void;
  /** The setting's own title, rendered beside the chooser as one settings row.
   * Null where the caller already labels the control above it, which keeps the
   * chooser stacked and full-width. */
  inlineLabel: React.ReactNode | null;
  disabled?: boolean;
}) {
  // Custom is sticky while it is chosen: a rule set can pass through a shape
  // one of the shortcuts also describes (owner-only, or no rules at all), and
  // the editor closing under the user mid-edit would be the wrong reading of
  // that. Every other mode is read straight off the policy, so a value that
  // arrives after mount — the settings page loads it — selects itself.
  const [customChosen, setCustomChosen] = useState(false);
  // The rules the user last had in the editor, kept across a trip through one
  // of the shortcuts so choosing Custom again does not start from scratch.
  const [customDraft, setCustomDraft] = useState<AddressingPolicy | null>(null);

  const mode: AddressingMode = customChosen ? 'custom' : addressingModeOf(value);

  const selectMode = (next: AddressingMode) => {
    if (next === mode) return;
    if (mode === 'custom') setCustomDraft(value);
    setCustomChosen(next === 'custom');
    onChange(policyForMode(next, next === 'custom' ? (customDraft ?? value) : value));
  };

  const chooser = (
    <Select
      value={mode}
      onValueChange={(next) => selectMode(next as AddressingMode)}
      disabled={disabled}
    >
      <SelectTrigger className={inlineLabel === null ? 'w-full' : 'shrink-0'}>
        {/* The label, not the value. Left to itself the trigger renders what
          is stored — "ownerAndAgents" — so the box contradicted the option
          just picked from it. */}
        <SelectValue>{MODE_LABELS[mode]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {MODE_ORDER.map((option) => (
          <SelectItem key={option} value={option}>
            {MODE_LABELS[option]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const hint = (
    <span className={cn('text-foreground-muted', inlineLabel === null ? 'text-xs' : 'text-sm')}>
      {MODE_HINTS[mode]}
    </span>
  );

  return (
    <div className="flex flex-col gap-3">
      {inlineLabel === null ? (
        <>
          {chooser}
          {hint}
        </>
      ) : (
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            {inlineLabel}
            {hint}
          </div>
          {chooser}
        </div>
      )}

      {policyNamesOwner(value) && unlinkedApps !== null && unlinkedApps.length > 0 && (
        <OwnerUnreachableWarning
          unlinkedApps={unlinkedApps}
          onOpenMessagingApps={onOpenMessagingApps}
        />
      )}

      {mode === 'custom' && value !== null && (
        <AddressingPolicyEditor
          value={value}
          onChange={onChange}
          rooms={rooms}
          roomGroups={roomGroups}
          users={users}
          agents={agents}
          disabled={disabled}
        />
      )}
    </div>
  );
}

/**
 * Shown when a rule admits the agent's owner but there are messaging apps the
 * signed-in user has claimed no account on — exactly the case where a privacy
 * control ends up admitting nobody. Silence here would look like a working
 * restriction right up until someone wonders why the agent never answers.
 *
 * It names the apps rather than saying "this server": linking Slack and leaving
 * Mattermost unclaimed leaves the rule half-working, and a message that only
 * fires when nothing at all is linked would have called that fine.
 */
function OwnerUnreachableWarning({
  unlinkedApps,
  onOpenMessagingApps,
}: {
  unlinkedApps: string[];
  onOpenMessagingApps: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-background-1 px-2 py-1.5 text-xs">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span>
          This admits the agent&apos;s owner, but you have not linked a messaging account on{' '}
          {listApps(unlinkedApps)} — so Switch cannot tell that a message from you there is from
          you, and the agent will answer nobody in those rooms.
        </span>
        {/* Messaging apps, not a claim dialog: an account is linked per app, and
          which app is being claimed is a decision that belongs beside the list
          of them rather than inside a button pressed from here. */}
        <button
          type="button"
          className="-mx-1 w-fit cursor-pointer rounded px-1 text-foreground underline underline-offset-2 transition-colors hover:bg-background-2"
          onClick={onOpenMessagingApps}
        >
          Open Messaging apps
        </button>
      </div>
    </div>
  );
}

function listApps(names: string[]): string {
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
