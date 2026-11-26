import { ChevronDown, MessagesSquare } from 'lucide-react';
import type { ComponentType } from 'react';
import type { RemoteBridge } from '../contracts/switch-servers';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../primitives/dropdown-menu';

/** Value of the option that needs no messaging app: the room lives in Switch itself. */
export const NO_MESSAGING_APP = '';

type Option = { value: string; label: string; type: string | null };

type SelectorBridge = Pick<RemoteBridge, 'id' | 'type' | 'displayName'>;

/** How the app draws a messaging app's icon, and whether it has one for a platform. */
export type BridgeIcons = {
  BridgeIcon: ComponentType<{ bridgeType: string; size: number; className?: string }>;
  hasBridgeIcon: (platform: string) => boolean;
};

export type MessagingAppSelectorProps = {
  /** The apps a room can be created on: running, and allowed to create channels. */
  bridges: readonly SelectorBridge[];
  /** Whether the server offers rooms with no messaging app (its `group_chats` flag). */
  consoleOffered: boolean;
  value: string;
  onChange: (value: string) => void;
  /** While a change is still being applied. */
  disabled?: boolean;
};

/** The app's own place for a room, named `homeLabel`, then each app a room can be created on. */
export function messagingOptions(bridges: readonly SelectorBridge[], homeLabel: string): Option[] {
  return [
    { value: NO_MESSAGING_APP, label: homeLabel, type: null },
    ...bridges.map((bridge) => ({
      value: bridge.id,
      label: bridge.displayName,
      type: bridge.type,
    })),
  ];
}

function OptionIcon({ type, icons }: { type: string | null; icons: BridgeIcons }) {
  return type !== null && icons.hasBridgeIcon(type) ? (
    <icons.BridgeIcon bridgeType={type} size={14} className="shrink-0" />
  ) : (
    <MessagesSquare className="size-3.5 shrink-0 text-foreground-muted" />
  );
}

/**
 * Where the room lives, as a pill in the dialog's footer. Absent when the
 * app's own place is the only choice: a selector with one option is a label
 * pretending to be a control.
 */
export function MessagingAppSelector({
  bridges,
  consoleOffered,
  value,
  onChange,
  disabled = false,
  homeLabel,
  icons,
}: MessagingAppSelectorProps & { homeLabel: string; icons: BridgeIcons }) {
  const options = messagingOptions(bridges, homeLabel).filter(
    (option) => consoleOffered || option.value !== NO_MESSAGING_APP
  );
  if (options.length < 2) return null;
  const selected = options.find((option) => option.value === value) ?? options[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Messaging app: ${selected.label}`}
        disabled={disabled}
        className="flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 text-sm text-foreground transition-colors hover:bg-[var(--sel-soft)] disabled:cursor-wait disabled:opacity-50"
      >
        <OptionIcon type={selected.type} icons={icons} />
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
                <OptionIcon type={option.type} icons={icons} />
                {option.label}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
