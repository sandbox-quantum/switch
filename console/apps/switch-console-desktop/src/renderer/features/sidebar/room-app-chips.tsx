import { appLabel, SWITCH_APP } from '@renderer/features/switch-servers/room-apps';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import { cn } from '@renderer/utils/utils';

/**
 * One chip per app the rooms are on, and All. There is nothing to choose
 * between when the rooms are on one app, so fewer than two renders nothing.
 */
export function RoomAppChips({
  apps,
  selected,
  onSelect,
}: {
  apps: string[];
  selected: string | null;
  onSelect: (app: string | null) => void;
}) {
  if (apps.length < 2) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-1 px-[9px] pb-1.5"
      role="group"
      aria-label="Show rooms on these apps"
    >
      <Chip pressed={selected === null} onClick={() => onSelect(null)}>
        All
      </Chip>
      {apps.map((app) => (
        <Chip key={app} pressed={selected === app} onClick={() => onSelect(app)}>
          {app !== SWITCH_APP && hasBridgeIcon(app) && (
            <BridgeIcon bridgeType={app} size={12} className="shrink-0" />
          )}
          {appLabel(app)}
        </Chip>
      ))}
    </div>
  );
}

function Chip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'flex h-6 items-center gap-1 rounded-md border px-2 text-[11.5px] font-medium transition-colors',
        pressed
          ? 'border-foreground/40 bg-background-2 text-foreground'
          : 'border-[var(--hair)] text-foreground/70 hover:bg-background-1 hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}
