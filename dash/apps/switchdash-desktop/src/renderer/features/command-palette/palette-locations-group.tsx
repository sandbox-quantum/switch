import { Command } from 'cmdk';
import { FolderOpen } from 'lucide-react';
import { useObserver } from 'mobx-react-lite';
import {
  asMounted,
  getLocationManagerStore,
} from '@renderer/features/locations/stores/location-selectors';
import type { NavigateFnTyped } from '@renderer/lib/layout/navigation-provider';
import { cn } from '@renderer/utils/utils';
import { PALETTE_ITEM_CLASS } from './palette-item-styles';

const GROUP_CLASS = cn(
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5',
  '[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium',
  '[&_[cmdk-group-heading]]:text-foreground/50'
);

interface PaletteLocationsGroupProps {
  /** When set, this location is excluded from the list (location scope). Undefined shows all (app scope). */
  currentLocationId: string | undefined;
  limit?: number;
  onClose: () => void;
  navigate: NavigateFnTyped;
}

export function PaletteLocationsGroup({
  currentLocationId,
  limit,
  onClose,
  navigate,
}: PaletteLocationsGroupProps) {
  const locations = useObserver(() => {
    const result: Array<{ id: string; name: string }> = [];
    for (const store of getLocationManagerStore().locations.values()) {
      const mounted = asMounted(store);
      if (!mounted) continue;
      if (mounted.data.id === currentLocationId) continue;
      result.push({ id: mounted.data.id, name: store.name ?? mounted.data.id });
    }
    return result;
  });

  const visible = limit !== undefined ? locations.slice(0, limit) : locations;

  if (visible.length === 0) return null;

  return (
    <Command.Group heading="Locations" className={GROUP_CLASS}>
      {visible.map((p) => (
        <Command.Item
          key={p.id}
          value={`location:${p.id}`}
          onSelect={() => {
            navigate('location', { locationId: p.id });
            onClose();
          }}
          className={PALETTE_ITEM_CLASS}
        >
          <FolderOpen size={14} className="shrink-0 text-foreground/40" />
          <span className="flex-1 truncate">{p.name}</span>
        </Command.Item>
      ))}
    </Command.Group>
  );
}
