import { Search } from 'lucide-react';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@renderer/lib/ui/combobox';

/**
 * A search box that picks one item from a list, hands it to the caller and
 * clears for the next pick. The box is the control rather than something a
 * button opens, because picking several in a row is the normal case. Rows are
 * the caller's to draw, so the same box serves agents, rooms and people.
 */
export function PickerCombobox<T extends { id: string }>({
  items,
  onPick,
  searchText,
  renderItem,
  placeholder,
  emptyText,
  disabled = false,
  onQueryChange,
}: {
  items: T[];
  onPick: (item: T) => void;
  /** The text a row is matched against as the user types. */
  searchText: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  placeholder: string;
  emptyText: string;
  disabled?: boolean;
  /** What the user has typed, for callers whose list depends on it (a live
   * directory search, an offer to use the typed text as-is). */
  onQueryChange?: (query: string) => void;
}) {
  return (
    <Combobox
      items={items}
      value={null}
      onValueChange={(next: T | null) => {
        if (next) onPick(next);
      }}
      onInputValueChange={onQueryChange ? (query: string) => onQueryChange(query) : undefined}
      isItemEqualToValue={(a: T, b: T) => a.id === b.id}
      filter={(item: T, query) => searchText(item).toLowerCase().includes(query.toLowerCase())}
      autoHighlight
    >
      <ComboboxInput
        showTrigger={false}
        disabled={disabled}
        placeholder={placeholder}
        leftAddon={<Search className="size-3.5 text-foreground-muted" />}
      />
      <ComboboxContent className="min-w-(--anchor-width)">
        <ComboboxList>
          {(item: T) => (
            <ComboboxItem key={item.id} value={item} showCheck={false}>
              {renderItem(item)}
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>{emptyText}</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  );
}
