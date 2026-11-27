import { ChevronRight } from 'lucide-react';
import { useId } from 'react';
import { BridgeIcon } from '../host';

const STACKED = ['slack', 'discord'];

/**
 * A small banner above New Room leading to where a messaging app is connected:
 * a chats sidebar lists no rooms on messaging apps (see `inAppRooms`).
 */
export function MessagingAppBanner({ onConnect }: { onConnect: () => void }) {
  const title = useId();
  const line = useId();
  return (
    <button
      type="button"
      onClick={onConnect}
      aria-labelledby={title}
      aria-describedby={line}
      className="group mb-1 flex w-full cursor-pointer items-center gap-2.5 rounded-xl border border-[var(--hair-soft)] bg-[var(--surface-2)] bg-[linear-gradient(135deg,color-mix(in_oklch,#5865F2_12%,transparent),color-mix(in_oklch,#E01E5A_7%,transparent))] px-2.5 py-2 text-left shadow-sm transition-[box-shadow,border-color,translate] hover:-translate-y-px hover:border-[var(--hair)] hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--hair)]"
    >
      <span aria-hidden className="flex shrink-0 -space-x-2">
        {STACKED.map((app) => (
          <span
            key={app}
            className="flex size-7 items-center justify-center rounded-full bg-background shadow-sm ring-2 ring-[var(--surface-2)]"
          >
            <BridgeIcon bridgeType={app} size={15} />
          </span>
        ))}
      </span>
      <span className="min-w-0 flex-1">
        <span id={title} className="block text-[12.5px] leading-snug font-medium text-foreground">
          Connect a messaging app
        </span>
        <span id={line} className="block text-[11.5px] leading-snug text-foreground-muted">
          Bring your agents to Slack or Discord
        </span>
      </span>
      <ChevronRight
        aria-hidden
        className="size-3.5 shrink-0 text-foreground-muted transition-transform group-hover:translate-x-0.5"
      />
    </button>
  );
}
