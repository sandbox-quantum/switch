import { ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
} from '@renderer/lib/ui/combobox';
import { cn } from '@renderer/utils/utils';
import type { HomeRoomOption } from './home-room-rank';

/** The option that stops the agent sharing a session. */
const NOT_SHARED: HomeRoomOption = { value: '', label: 'Not shared', detail: '' };

type Group = { value: string; label: string; items: HomeRoomOption[] };

/**
 * Picks the room an agent's shared session is based in: a searchable list,
 * the likeliest rooms first, so a workspace with hundreds of rooms stays
 * usable. Choosing "Not shared" stops the agent sharing a session.
 */
export function HomeRoomPicker({
  value,
  suggested,
  all,
  disabled,
  onChange,
}: {
  /** The current home room's id, or null when the agent shares no session. */
  value: string | null;
  suggested: HomeRoomOption[];
  all: HomeRoomOption[];
  disabled?: boolean;
  onChange: (roomId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const groups = useMemo<Group[]>(() => {
    const out: Group[] = [];
    if (value) out.push({ value: 'off', label: '', items: [NOT_SHARED] });
    if (suggested.length) out.push({ value: 'suggested', label: 'Suggested', items: suggested });
    if (all.length)
      out.push({ value: 'all', label: suggested.length ? 'All rooms' : '', items: all });
    return out;
  }, [value, suggested, all]);
  const selected =
    [...suggested, ...all].find((option) => option.value === value) ?? (value ? null : NOT_SHARED);

  return (
    <Combobox
      items={groups}
      value={selected}
      onValueChange={(item: HomeRoomOption | null) => {
        if (!item) return;
        setOpen(false);
        onChange(item.value || null);
      }}
      open={open}
      onOpenChange={disabled ? undefined : setOpen}
      isItemEqualToValue={(a: HomeRoomOption, b: HomeRoomOption) => a.value === b.value}
      filter={(item: HomeRoomOption, query) =>
        item.label.toLowerCase().includes(query.toLowerCase())
      }
      autoHighlight
    >
      <ComboboxTrigger
        aria-label="Home room"
        disabled={disabled}
        className={cn(
          'flex h-8 w-64 min-w-0 items-center gap-2 rounded-md border border-border bg-transparent px-2.5 py-1 text-sm outline-none not-disabled:hover:bg-background-1',
          disabled && 'cursor-not-allowed opacity-60'
        )}
      >
        <span className={cn('flex-1 truncate text-left', !value && 'text-foreground-muted')}>
          {value ? (selected?.label ?? 'Home room') : 'Not shared'}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-foreground-muted" />
      </ComboboxTrigger>
      <ComboboxContent className="w-80 min-w-(--anchor-width)" align="end">
        <ComboboxInput showTrigger={false} placeholder="Search rooms..." />
        <ComboboxList className="max-h-80 pb-0">
          {(group: Group) => (
            <ComboboxGroup key={group.value} items={group.items} className="py-1">
              {group.label && <ComboboxLabel>{group.label}</ComboboxLabel>}
              <ComboboxCollection>
                {(item: HomeRoomOption) => (
                  <ComboboxItem key={item.value || 'off'} value={item}>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.detail && (
                      <span className="ml-2 shrink-0 text-xs text-foreground-muted">
                        {item.detail}
                      </span>
                    )}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
        <ComboboxEmpty>No room matches.</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  );
}
