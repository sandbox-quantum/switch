import { Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { useAgentAccent } from '@renderer/lib/components/agent-accent';
import { AgentAvatar } from '@renderer/lib/components/agent-avatar';
import { cn } from '@renderer/utils/utils';
import { agentInitials } from '@shared/core/agents/agent-avatar';
import { type Participant, pickerKey, searchParticipants } from './participant-search';

/** A person's initials disc, as the chat timeline draws people. */
function Initials({ name, size }: { name: string; size: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      className="flex shrink-0 items-center justify-center rounded-full bg-[var(--fill-2)] font-medium text-foreground"
    >
      {agentInitials(name)}
    </span>
  );
}

function Mark({
  participant,
  serverId,
  size,
}: {
  participant: Participant;
  serverId: string | null;
  size: number;
}) {
  return participant.kind === 'agent' ? (
    <AgentAvatar
      name={participant.name}
      iconUrl={participant.iconUrl}
      serverId={serverId}
      size={size}
    />
  ) : (
    <Initials name={participant.name} size={size} />
  );
}

/** A picked participant: an agent tinted with its avatar's colour, a person in grey. */
export function ParticipantChip({
  participant,
  serverId,
  onRemove,
  disabled,
}: {
  participant: Participant;
  serverId: string | null;
  onRemove: () => void;
  disabled: boolean;
}) {
  const accent = useAgentAccent(participant.kind === 'agent' ? participant : null, serverId);
  return (
    <span
      className={cn(
        'flex h-6 max-w-full items-center gap-1.5 rounded-full py-0.5 pr-0.5 pl-0.5 text-sm text-foreground',
        !accent && 'bg-[var(--fill-2)]'
      )}
      style={
        accent ? { backgroundColor: `color-mix(in srgb, ${accent} 20%, transparent)` } : undefined
      }
    >
      <Mark participant={participant} serverId={serverId} size={18} />
      <span className="truncate">{participant.name}</span>
      <button
        type="button"
        aria-label={`Remove ${participant.name}`}
        disabled={disabled}
        onClick={onRemove}
        className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-foreground-muted hover:bg-[var(--sel-soft)] hover:text-foreground disabled:cursor-wait disabled:opacity-50"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

/**
 * One field that finds agents and people together and keeps the picked ones
 * as chips inside it. Up and down move through the results, Enter adds,
 * Backspace on an empty field takes the last chip back, Escape closes the list.
 */
export function ParticipantPicker({
  candidates,
  picked,
  onChange,
  serverId,
  loading,
  inputId,
  autoFocus,
  busy,
  overlay,
}: {
  candidates: Participant[];
  picked: Participant[];
  onChange: (next: Participant[]) => void;
  serverId: string | null;
  loading: boolean;
  /** For the field's label. */
  inputId: string;
  autoFocus: boolean;
  /** A pick is being applied: the field takes no other until it is, and says so. */
  busy: boolean;
  /** The results float over what follows the field; otherwise they push it down, as a dialog needs. */
  overlay: boolean;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const results = searchParticipants(candidates, picked, query);
  const current = Math.min(active, Math.max(results.length - 1, 0));

  const add = (participant: Participant) => {
    if (busy) return;
    onChange([...picked, participant]);
    setQuery('');
    setActive(0);
  };

  return (
    <div className={cn(overlay && 'relative')}>
      <div
        // The standard input's border, radius and focus ring, around chips that wrap.
        className="focus-within:ring-primary/30 dark:bg-input/30 flex min-h-8 w-full flex-wrap items-center gap-1 rounded-md border border-border bg-transparent px-1 py-0.5 transition-[color,box-shadow] focus-within:border-border-primary focus-within:ring-2 hover:border-border-1"
        onClick={(event) =>
          (event.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()
        }
      >
        {picked.map((participant) => (
          <ParticipantChip
            key={`${participant.kind}:${participant.id}`}
            participant={participant}
            serverId={serverId}
            onRemove={() => onChange(picked.filter((each) => each !== participant))}
            // The picks are being applied as they stand; changing them now would change nothing.
            disabled={busy}
          />
        ))}
        <input
          id={inputId}
          autoFocus={autoFocus}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${inputId}-results`}
          aria-label="Add agents or people"
          placeholder={picked.length === 0 ? 'Add agents or people…' : ''}
          className="h-6 min-w-32 flex-1 bg-transparent px-1.5 text-sm outline-none placeholder:text-foreground-passive aria-disabled:opacity-50"
          // Read-only rather than disabled while busy, so focus stays for the next pick.
          readOnly={busy}
          aria-disabled={busy}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            // keyCode 229: a key the IME is handling, which some IMEs send with isComposing false.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            // ⌘↩ / Ctrl+↩ confirms the form around the field; it is not a pick.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) return;
            const action = pickerKey(event.key, {
              query,
              open,
              active: current,
              results: results.length,
              picked: picked.length,
            });
            if (!action) return;
            event.preventDefault();
            event.stopPropagation();
            if (action.type === 'move') {
              setOpen(true);
              setActive(action.active);
            } else if (action.type === 'add') add(results[current]);
            else if (action.type === 'removeLast') {
              if (!busy) onChange(picked.slice(0, -1));
            } else setOpen(false);
          }}
        />
        {busy && (
          <span
            role="status"
            className="flex items-center gap-1 px-1.5 text-xs text-foreground-muted"
          >
            <Loader2 className="size-3 animate-spin" />
            Adding…
          </span>
        )}
      </div>
      {open && (
        // A dialog clips what overflows it, so there the list grows it instead of floating.
        <div
          id={`${inputId}-results`}
          role="listbox"
          className={cn(
            'mt-1 max-h-60 overflow-y-auto rounded-[10px] border border-border bg-background p-1',
            overlay ? 'absolute inset-x-0 top-full z-20 shadow-lg' : 'shadow-sm'
          )}
        >
          {loading ? (
            <p className="px-2.5 py-2 text-sm text-foreground-muted">Loading…</p>
          ) : results.length === 0 ? (
            <p className="px-2.5 py-2 text-sm text-foreground-muted">
              {query.trim() === ''
                ? 'Everyone you can add is already in.'
                : `No agent or person matches “${query.trim()}”.`}
            </p>
          ) : (
            results.map((participant, index) => (
              <div
                key={`${participant.kind}:${participant.id}`}
                role="option"
                aria-selected={index === current}
                aria-disabled={busy}
                // Keeps focus in the field, so the list stays open for the next pick.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => add(participant)}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm aria-disabled:cursor-wait aria-disabled:opacity-50',
                  index === current && 'bg-[var(--sel-soft)]'
                )}
              >
                <Mark participant={participant} serverId={serverId} size={22} />
                <span className="min-w-0 flex-1 truncate text-foreground">{participant.name}</span>
                <span className="shrink-0 truncate text-xs text-foreground-muted">
                  {participant.detail}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
