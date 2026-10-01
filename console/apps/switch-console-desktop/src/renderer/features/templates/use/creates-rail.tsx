import { Check, ChevronRight, DoorOpen, Loader2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { ParsedAgentEntry } from '@main/core/agent-templates/template-document';
import type { TemplateRoom } from '@main/core/room-templates/controller';
import { AgentField, type EntityLists } from '@renderer/features/room-templates/entity-fields';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { SegmentedControl } from '@renderer/lib/ui/segmented-control';
import { Switch } from '@renderer/lib/ui/switch';
import { cn } from '@renderer/utils/utils';
import { hasPlaceholder, interpolate, type Values } from './use-template-model';

export type SlotStatus = 'idle' | 'creating' | 'created' | 'failed';

/**
 * One agent entry of the template and the choices made for it on the Use
 * page: create it or, when the template allows it, use an existing agent;
 * whether to clone its repository; and how far creation got.
 */
export type AgentSlot = {
  entry: ParsedAgentEntry;
  /** `existing` only for an entry whose template sets `allow_existing: true`. */
  mode: 'new' | 'existing';
  /** The existing agent's name, when `mode` is `existing`. */
  existingName: string;
  cloneRepo: boolean;
  status: SlotStatus;
  error: string | null;
  /** Null until the agent is created, then the name it was created under. */
  createdName: string | null;
  createdSwitchAgentId: string | null;
  /** The call in progress, or the one that failed, while the agent is being created. */
  step: SlotStep | null;
  /** Why the repository could not be cloned. The run carries on without the clone. */
  cloneWarning: string | null;
};

/** The calls that make one agent: its directory (and clone), the agent, who may address it. */
export type SlotStep = 'prepare' | 'create' | 'policy';

export function newSlot(entry: ParsedAgentEntry): AgentSlot {
  return {
    entry,
    mode: 'new',
    existingName: '',
    cloneRepo: true,
    status: 'idle',
    error: null,
    createdName: null,
    createdSwitchAgentId: null,
    step: null,
    cloneWarning: null,
  };
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
  room: TemplateRoom;
  values: Values;
  /** Agent name as written in the template → the name the agent will have. */
  renames: Record<string, string>;
  bridgeName: string | null;
  creatorIdentity: string | null;
  status: SlotStatus;
  /** For an agent template, whether to create the room. Null hides the toggle: the room is not optional, or creation has started. */
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

/** What runs a new agent, where, and in which folder, as the inputs resolve them. */
export type SlotRuntime = {
  provider: string | null;
  location: string | null;
  directory: string | null;
};

function RuntimeRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-baseline gap-3 text-xs">
      <span className="w-[72px] shrink-0 text-foreground-passive">{label}</span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate font-mono',
          value === null ? 'text-amber-600 dark:text-amber-400' : 'text-foreground-muted'
        )}
      >
        {value ?? 'Not set by the template'}
      </span>
    </div>
  );
}

export function AgentSlotCard({
  slot,
  wantedName,
  runtime,
  onChange,
  lists,
  busy,
  children,
}: {
  slot: AgentSlot;
  /** The name the agent is created under, as far as the inputs resolve it. */
  wantedName: string;
  /** What a new agent runs with. Null for an existing agent. */
  runtime: SlotRuntime | null;
  onChange: (next: AgentSlot) => void;
  lists: EntityLists;
  busy: boolean;
  /** Notices about the machine it runs on. */
  children?: React.ReactNode;
}) {
  const existing = slot.mode === 'existing';
  const existingName = slot.existingName;
  const unresolved = hasPlaceholder(wantedName) || wantedName === '';
  const shownName = existing ? existingName || 'Pick an agent' : (slot.createdName ?? wantedName);
  return (
    <Card className={cn(slot.status === 'failed' && 'border-destructive/50')}>
      <div className="flex items-center gap-3">
        <AgentAvatar name={shownName || 'agent'} iconUrl={null} size={28} />
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              'truncate font-mono text-[13px] font-medium',
              (existing ? existingName === '' : unresolved)
                ? 'text-foreground-passive'
                : 'text-foreground'
            )}
          >
            {shownName || 'Named by an input'}
          </div>
          <div className="mt-0.5 truncate text-xs leading-snug text-foreground-muted">
            {slot.entry.description || 'An agent with its own instructions'}
          </div>
        </div>
        <span className="shrink-0 text-[11px] text-foreground-passive">
          {existing ? 'Existing agent' : 'Agent'}
        </span>
      </div>

      {/* Offered only when the template allows it. An agent that exists can no
          longer change how it is made, even when a later step for it failed. */}
      {slot.entry.allowExisting &&
        (slot.status === 'idle' || slot.status === 'failed') &&
        slot.createdName === null && (
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
            {existing && (
              <AgentField
                value={slot.existingName}
                onChange={(name) => onChange({ ...slot, existingName: name })}
                lists={lists}
              />
            )}
          </div>
        )}

      {runtime && (
        <div className="mt-3 flex flex-col gap-1.5 border-t border-border pt-3">
          <RuntimeRow label="Provider" value={runtime.provider} />
          <RuntimeRow label="Runs on" value={runtime.location} />
          <RuntimeRow label="Directory" value={runtime.directory} />
          {slot.entry.repoUrl && slot.createdName === null && (
            <label className="mt-1 flex w-max cursor-pointer items-center gap-2 text-xs text-foreground-muted">
              <Switch
                size="sm"
                checked={slot.cloneRepo}
                disabled={busy}
                onCheckedChange={(cloneRepo) => onChange({ ...slot, cloneRepo })}
              />
              Clone {slot.entry.repoUrl.replace(/^https?:\/\//, '')} into it
            </label>
          )}
          {children}
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

/** The template document with the inputs filled in, one line per row, with the changed lines highlighted. */
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
