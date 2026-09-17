import { Check, ChevronRight, DoorOpen, Loader2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { ParsedAgentEntry } from '@main/core/agent-templates/controller';
import type { ParsedRoom } from '@main/core/room-templates/controller';
import { LocalDirectorySelector } from '@renderer/features/locations/components/add-agent-modal/local-directory-selector';
import { AgentField, type EntityLists } from '@renderer/features/room-templates/entity-fields';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { Input } from '@renderer/lib/ui/input';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import { Switch } from '@renderer/lib/ui/switch';
import { cn } from '@renderer/utils/utils';
import { hasPlaceholder, interpolate, type Values } from './use-template-model';

export type SlotStatus = 'idle' | 'creating' | 'created' | 'failed';

/** One agent the template creates, and what the person decided about it. */
export type AgentSlot = {
  entry: ParsedAgentEntry;
  /** Make it, or point the room at one the server already has. */
  mode: 'new' | 'existing';
  /** The existing agent's name, when `mode` is `existing`. */
  existingName: string;
  /** The working directory for a new agent: a local path, or a path on the host. */
  dir: string;
  /** Whether the person chose the directory themselves; a chosen path stays put when the name changes. */
  dirPicked: boolean;
  cloneRepo: boolean;
  status: SlotStatus;
  error: string | null;
  /** The name it was actually created under, once it was. */
  createdName: string | null;
  createdSwitchAgentId: string | null;
};

export function newSlot(entry: ParsedAgentEntry): AgentSlot {
  return {
    entry,
    mode: 'new',
    existingName: '',
    dir: '',
    dirPicked: false,
    cloneRepo: true,
    status: 'idle',
    error: null,
    createdName: null,
    createdSwitchAgentId: null,
  };
}

/** The name a slot will go by once created: the template's, filled in. */
export function slotWantedName(slot: AgentSlot, values: Values, override: string | null): string {
  if (override !== null) return override;
  return interpolate(slot.entry.name ?? '', values);
}

function StatusLine({ slot }: { slot: AgentSlot }) {
  if (slot.status === 'creating')
    return (
      <span className="flex items-center gap-1 text-[11px] text-foreground-muted">
        <Loader2 className="size-3 animate-spin" /> Creating…
      </span>
    );
  if (slot.status === 'created')
    return (
      <span className="flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400">
        <Check className="size-3" /> Created
      </span>
    );
  if (slot.status === 'failed')
    return (
      <span className="flex items-center gap-1 text-[11px] text-destructive">
        <TriangleAlert className="size-3" /> Failed
      </span>
    );
  return null;
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-[10px] border border-border bg-background p-3', className)}>
      {children}
    </div>
  );
}

export function RoomCard({
  room,
  values,
  renames,
  bridgeName,
  creatorIdentity,
  status,
  toggle,
}: {
  room: ParsedRoom;
  values: Values;
  /** Agent name as written in the template → the name the agent will actually have. */
  renames: Record<string, string>;
  bridgeName: string | null;
  creatorIdentity: string | null;
  status: SlotStatus;
  /** When the room is optional: whether to make it. Null when it is not a choice. */
  toggle: { checked: boolean; onChange: (checked: boolean) => void } | null;
}) {
  const fill = (s: string) =>
    interpolate(renames[s] ?? s, { ...values, $creator: creatorIdentity ?? 'you' });
  const name = room.name ? fill(room.name) : 'Unnamed room';
  const members = [...room.agents, ...room.users].map(fill);
  const note =
    room.description?.trim() ||
    (members.length > 0 ? `With ${members.join(', ')}` : 'A room with nobody in it yet');
  return (
    <Card>
      <div className="flex items-center gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-background-2 text-foreground-muted">
          <DoorOpen className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              'truncate font-mono text-[13px] font-medium',
              hasPlaceholder(name) ? 'text-foreground-passive' : 'text-foreground'
            )}
          >
            {name}
          </div>
          <div className="mt-0.5 text-xs leading-snug text-foreground-muted">
            {fill(note)}
            {bridgeName ? ` · on ${bridgeName}` : ''}
          </div>
        </div>
        <span className="shrink-0 text-[11px] text-foreground-passive">Room</span>
      </div>
      {toggle && (
        <label className="mt-3 flex w-max cursor-pointer items-center gap-2 border-t border-border pt-3 text-xs text-foreground-muted">
          <Switch size="sm" checked={toggle.checked} onCheckedChange={toggle.onChange} />
          {toggle.checked
            ? 'Create this room and start the agent in it'
            : 'Agent only; add it to a room later'}
        </label>
      )}
      {status !== 'idle' && (
        <div className="mt-2">
          <StatusLine slot={{ status } as AgentSlot} />
        </div>
      )}
    </Card>
  );
}

export function AgentSlotCard({
  slot,
  wantedName,
  finalName,
  onChange,
  lists,
  sshHost,
  locationLabel,
  busy,
}: {
  slot: AgentSlot;
  /** The name the template asks for, filled in. */
  wantedName: string;
  /** The name it will actually get: `wantedName`, or the first free variant. */
  finalName: string;
  onChange: (next: AgentSlot) => void;
  lists: EntityLists;
  sshHost: string | null;
  /** Where the agents run, for the existing-agent picker's hint. */
  locationLabel: string;
  busy: boolean;
}) {
  const unresolved = hasPlaceholder(wantedName) || wantedName === '';
  const shownName =
    slot.mode === 'existing'
      ? slot.existingName || 'Pick an agent'
      : (slot.createdName ?? (finalName || wantedName));
  return (
    <Card className={cn(slot.status === 'failed' && 'border-destructive/50')}>
      <div className="flex items-center gap-3">
        <AgentAvatar name={shownName || 'agent'} iconUrl={null} size={28} />
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              'truncate font-mono text-[13px] font-medium',
              unresolved && slot.mode === 'new' ? 'text-foreground-passive' : 'text-foreground'
            )}
          >
            {shownName || 'Named by an input'}
          </div>
          <div className="mt-0.5 truncate text-xs leading-snug text-foreground-muted">
            {slot.entry.description || 'An agent with its own instructions'}
          </div>
        </div>
        <span className="shrink-0 text-[11px] text-foreground-passive">Agent</span>
      </div>

      {(slot.status === 'idle' || slot.status === 'failed') && (
        <div className="mt-3 flex flex-col gap-2.5 border-t border-border pt-3">
          <SegmentedControl
            value={slot.mode}
            onChange={(mode) => onChange({ ...slot, mode })}
            options={[
              { value: 'new', label: 'New agent' },
              { value: 'existing', label: 'Existing agent' },
            ]}
            ariaLabel={`How to fill ${wantedName || 'this agent'}`}
            className="w-max"
          />
          {slot.mode === 'existing' ? (
            <div className="flex flex-col gap-1.5">
              <AgentField
                value={slot.existingName}
                onChange={(name) => onChange({ ...slot, existingName: name })}
                lists={lists}
              />
              <p className="text-[11px] text-foreground-passive">
                {lists.agents.length === 0
                  ? `No agent of yours runs on ${locationLabel} yet.`
                  : `Agents of yours that run on ${locationLabel}.`}
              </p>
            </div>
          ) : (
            <>
              {finalName !== wantedName && finalName !== '' && (
                <p className="text-[11.5px] text-foreground-muted">
                  An agent called {wantedName} already exists on this server, so this one will be{' '}
                  <span className="font-mono">{finalName}</span>.
                </p>
              )}
              <div className="flex flex-col gap-1">
                <span className="text-[11px] text-foreground-passive">Directory</span>
                {sshHost ? (
                  <Input
                    value={slot.dir}
                    disabled={busy}
                    placeholder="/home/agent/repo"
                    className="font-mono text-xs"
                    onChange={(e) => onChange({ ...slot, dir: e.target.value, dirPicked: true })}
                  />
                ) : (
                  <LocalDirectorySelector
                    title="Choose the agent's working directory"
                    message="The agent runs from here. A suggested folder is created when the agent is."
                    path={slot.dir}
                    onPathChange={(dir) => onChange({ ...slot, dir, dirPicked: true })}
                  />
                )}
              </div>
              {slot.entry.repoUrl && (
                <label className="flex w-max cursor-pointer items-center gap-2 text-xs text-foreground-muted">
                  <Switch
                    size="sm"
                    checked={slot.cloneRepo}
                    onCheckedChange={(cloneRepo) => onChange({ ...slot, cloneRepo })}
                  />
                  Clone {slot.entry.repoUrl.replace(/^https?:\/\//, '')} into it
                </label>
              )}
            </>
          )}
        </div>
      )}
      {slot.status !== 'idle' && (
        <div className="mt-2 flex flex-col gap-1">
          <StatusLine slot={slot} />
          {slot.error && <p className="text-xs text-destructive">{slot.error}</p>}
        </div>
      )}
    </Card>
  );
}

/** The document with the inputs filled in, line by line, the filled lines marked. */
export function ResolvedDocument({
  yamlText,
  values,
  renames,
}: {
  yamlText: string;
  values: Values;
  renames: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const renamed = Object.entries(renames).reduce(
    (text, [from, to]) => text.split(from).join(to),
    yamlText
  );
  const lines = renamed.replace(/\n$/, '').split('\n');
  return (
    <div className="flex flex-col gap-2.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-max cursor-pointer items-center gap-2 text-[12.5px] font-medium text-foreground-muted hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            'size-3.5 text-foreground-passive transition-transform',
            open && 'rotate-90'
          )}
        />
        {open ? 'Hide the resolved document' : 'Show the resolved document'}
      </button>
      {open && (
        <div className="overflow-x-auto rounded-[10px] border border-border bg-background p-3 font-mono text-xs leading-relaxed">
          {lines.map((line, i) => {
            const filled = interpolate(line, values);
            const changed = filled !== line;
            return (
              <div
                key={i}
                className={cn(
                  'flex gap-3 rounded-sm whitespace-pre-wrap',
                  changed && 'bg-[var(--sel-soft)]'
                )}
              >
                <span className="w-5 shrink-0 text-right text-foreground-passive opacity-60">
                  {i + 1}
                </span>
                <span
                  className={cn(
                    'min-w-0 flex-1',
                    hasPlaceholder(filled) ? 'text-foreground-passive' : 'text-foreground'
                  )}
                >
                  {filled}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
