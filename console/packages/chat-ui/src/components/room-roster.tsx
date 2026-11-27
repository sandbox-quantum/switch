import { ChevronDown, ChevronRight, Loader2, MoreHorizontal, Plus, UserPlus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cn } from '../model/cn';
import { roomAgentPresence } from '../model/room-agent-presence';
import { Button } from '../primitives/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../primitives/dropdown-menu';
import { PersonMark } from './person-mark';

const TONE_CLASS = {
  live: 'bg-foreground-success',
  idle: 'bg-foreground-warning',
  off: 'bg-[var(--fg-passive)]',
} as const;

/** One agent in the room, as the app knows it: what it shows and what the viewer may do. */
export type RosterAgent = {
  id: string;
  label: string;
  /** The name the server keeps unique, shown beside `label` when it differs (`chatAgentNaming`). */
  uniqueName: string | null;
  /** Its picture, drawn as the app draws agents. */
  mark: ReactNode;
  /** What the server reports it doing here; undefined where nothing is known. */
  status: string | undefined;
  /** The room's roles it holds. */
  roles: string[];
  /** Opens its seat in this room, for the viewer's own agents; null for anyone else's. */
  open: (() => void) | null;
  /** Whether it is told when someone joins, and the way to change it; null where the viewer may not. */
  joinEvents: { listening: boolean; set: (on: boolean) => Promise<void> } | null;
  /** Takes it out of the room; null for someone who may not. */
  remove: (() => Promise<void>) | null;
};

export type PersonAction = {
  label: string;
  run: () => Promise<void>;
  /** What to say when it fails. */
  failure: string;
  destructive?: boolean;
};

/** One person in the room. */
export type RosterPerson = {
  key: string;
  name: string;
  /** Their Switch user, when known, for their colour. */
  userId: string | null;
  /** For a messaging-app username, the name of the Switch user who linked it, shown in brackets. */
  fullName: string | null;
  detail: string | null;
  /** What the viewer may do about this person; no menu when there is nothing. */
  actions: PersonAction[];
};

export type RosterFold<Row> = {
  title: string;
  count: number;
  /** Opens adding to it, or null for someone who may not. */
  onAdd: (() => void) | null;
  addLabel: string;
  rows: Row[];
  /** Said in place of the rows when there are none, or when they could not be read. */
  empty: string | null;
  /** Said under the rows. */
  notes: string[];
};

/**
 * Who is in the room, beside it: the agents and what each is doing here, and
 * the people, with the room admins where the room has them. Whoever may change
 * the room adds and removes them here; what adding opens is the app's
 * (`dialog`). Console and the web dashboard each fill it from their own reads.
 */
export function RoomRoster({
  addParticipants,
  agents,
  people,
  admins,
  describe,
  dialog,
}: {
  /** One button adding agents and people alike, for a chat in Switch; null for a room. */
  addParticipants: (() => void) | null;
  agents: RosterFold<RosterAgent>;
  people: RosterFold<RosterPerson>;
  admins: RosterFold<RosterPerson> | null;
  /** A failure, in words for the person. */
  describe: (cause: unknown, fallback: string) => string;
  /** The app's dialog for adding, drawn here so it opens beside the roster. */
  dialog: ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  const act = async (action: () => Promise<void>, fallback: string) => {
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(describe(cause, fallback));
    }
  };

  return (
    <aside
      aria-label="Room"
      className="flex w-[260px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-border p-2"
    >
      {/* A chat in Switch takes people as well as agents, so its add is its own
      button, not the + beside Agents, which reads as agents only. */}
      {addParticipants && (
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start"
          onClick={addParticipants}
        >
          <UserPlus />
          Add participants
        </Button>
      )}
      <Fold fold={agents}>
        {agents.rows.map((agent) => (
          <AgentRow key={agent.id} agent={agent} act={act} />
        ))}
      </Fold>
      <Fold fold={people}>
        {people.rows.map((person) => (
          <PersonRow key={person.key} person={person} act={act} />
        ))}
      </Fold>
      {admins && (
        <Fold fold={admins}>
          {admins.rows.map((person) => (
            <PersonRow key={person.key} person={person} act={act} />
          ))}
        </Fold>
      )}
      {error !== null && <p className="px-2 text-xs text-destructive">{error}</p>}
      {dialog}
    </aside>
  );
}

function AgentRow({
  agent,
  act,
}: {
  agent: RosterAgent;
  act: (action: () => Promise<void>, fallback: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const presence = roomAgentPresence(agent.status);
  const detail = [agent.status === undefined ? null : presence.label, ...agent.roles]
    .filter(Boolean)
    .join(' · ');
  const body = (
    <>
      <span className="relative flex shrink-0">
        {agent.mark}
        {agent.status !== undefined && (
          <span
            aria-hidden
            className={cn(
              'absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-background',
              TONE_CLASS[presence.tone]
            )}
          />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] text-foreground">
          {agent.label}
          {agent.uniqueName && (
            <span className="text-foreground-passive"> @{agent.uniqueName}</span>
          )}
        </span>
        {detail && <span className="truncate text-xs text-foreground-muted">{detail}</span>}
      </span>
    </>
  );
  const run = (action: () => Promise<void>, fallback: string) => {
    setBusy(true);
    void act(action, fallback).finally(() => setBusy(false));
  };
  const { joinEvents, remove } = agent;
  const menu =
    remove || joinEvents ? (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`${agent.label} in this room`}
              className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"
            >
              {busy ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          {joinEvents && (
            <DropdownMenuCheckboxItem
              checked={joinEvents.listening}
              onCheckedChange={(next) =>
                run(() => joinEvents.set(next), 'Could not change the join notification.')
              }
            >
              Tell it when someone joins
            </DropdownMenuCheckboxItem>
          )}
          {remove && (
            <DropdownMenuItem
              variant="destructive"
              onClick={() => run(remove, `Could not remove ${agent.label}.`)}
            >
              Remove from room
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  return (
    <div className="group flex items-center gap-1 rounded-md pr-1 hover:bg-[var(--sel-soft)]">
      {agent.open ? (
        <button
          type="button"
          title={`Open ${agent.label}’s session in this room`}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-1 text-left"
          onClick={agent.open}
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1">{body}</div>
      )}
      {menu}
    </div>
  );
}

function PersonRow({
  person,
  act,
}: {
  person: RosterPerson;
  act: (action: () => Promise<void>, fallback: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="group flex items-center gap-2 rounded-md py-1 pr-1 pl-2 hover:bg-[var(--sel-soft)]">
      <PersonMark name={person.name} userId={person.userId} size="sm" />
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
        {person.name}
        {person.fullName !== null && (
          <span className="text-foreground-muted"> ({person.fullName})</span>
        )}
      </span>
      {person.detail && (
        <span className="shrink-0 text-xs text-foreground-muted">{person.detail}</span>
      )}
      {person.actions.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`${person.name} in this room`}
                className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"
              >
                {busy ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            {person.actions.map((action) => (
              <DropdownMenuItem
                key={action.label}
                variant={action.destructive ? 'destructive' : 'default'}
                onClick={() => {
                  setBusy(true);
                  void act(action.run, action.failure).finally(() => setBusy(false));
                }}
              >
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function Fold<Row>({ fold, children }: { fold: RosterFold<Row>; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section aria-label={fold.title} className="flex flex-col gap-[2px]">
      <div className="flex items-center gap-1 px-1 pb-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex flex-1 items-center gap-1 text-xs font-medium text-foreground-muted hover:text-foreground"
        >
          <Chevron className="size-3.5" />
          <span className="flex-1 text-left">{fold.title}</span>
          <span className="text-[var(--fg-passive)] tabular-nums">{fold.count}</span>
        </button>
        {fold.onAdd && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={fold.addLabel}
            title={fold.addLabel}
            onClick={fold.onAdd}
          >
            <Plus />
          </Button>
        )}
      </div>
      {open && (
        <>
          {fold.empty !== null && <Note>{fold.empty}</Note>}
          {children}
          {fold.notes.map((note) => (
            <Note key={note}>{note}</Note>
          ))}
        </>
      )}
    </section>
  );
}

const Note = ({ children }: { children: ReactNode }) => (
  <p className="px-2 py-1 text-xs text-foreground-muted">{children}</p>
);
