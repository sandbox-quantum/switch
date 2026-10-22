import { ChevronDown, MessagesSquare } from 'lucide-react';
import { BridgeIcon, hasBridgeIcon } from '@renderer/lib/components/bridge-icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import type { RemoteBridge } from '@shared/core/switch-servers/switch-servers';

/** Value of the Switch Console option, which needs no messaging app. */
export const SWITCH_CONSOLE = '';

type Option = { value: string; label: string; type: string | null };

/** Switch Console, then each app a room can be created on. */
export function messagingOptions(bridges: readonly RemoteBridge[]): Option[] {
  return [
    { value: SWITCH_CONSOLE, label: 'Switch Console', type: null },
    ...bridges.map((bridge) => ({
      value: bridge.id,
      label: bridge.displayName,
      type: bridge.type,
    })),
  ];
}

function OptionIcon({ type }: { type: string | null }) {
  return type !== null && hasBridgeIcon(type) ? (
    <BridgeIcon bridgeType={type} size={14} className="shrink-0" />
  ) : (
    <MessagesSquare className="size-3.5 shrink-0 text-foreground-muted" />
  );
}

/**
 * Where the room lives, as a pill in the dialog's footer. Absent when Switch
 * Console is the only choice: a selector with one option is a label pretending
 * to be a control.
 */
export function MessagingAppSelector({
  bridges,
  value,
  onChange,
}: {
  /** The apps a room can be created on: running, and allowed to create channels. */
  bridges: readonly RemoteBridge[];
  value: string;
  onChange: (value: string) => void;
}) {
  const options = messagingOptions(bridges);
  if (options.length < 2) return null;
  const selected = options.find((option) => option.value === value) ?? options[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Messaging app: ${selected.label}`}
        className="flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 text-sm text-foreground transition-colors hover:bg-[var(--sel-soft)]"
      >
        <OptionIcon type={selected.type} />
        <span className="max-w-40 truncate">{selected.label}</span>
        <ChevronDown className="size-3.5 shrink-0 text-foreground-muted" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        <DropdownMenuRadioGroup value={selected.value}>
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              onClick={() => onChange(option.value)}
            >
              <span className="flex items-center gap-2">
                <OptionIcon type={option.type} />
                {option.label}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
