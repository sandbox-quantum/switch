import { Cloud } from 'lucide-react';
import type { SharedCloudPresentation, SharedCloudTone } from './shared-cloud-state';

const DOT: Record<SharedCloudTone, string> = {
  working: 'bg-[var(--green-9)] shadow-[0_0_0_3px_var(--green-4)]',
  idle: 'bg-[var(--blue-9)]',
  waking: 'bg-[var(--amber-9)]',
  resting: 'bg-[var(--neutral-9)]',
  problem: 'bg-[var(--red-9)]',
  off: 'bg-[var(--neutral-9)]',
};

/**
 * An agent's state on the shared cloud: a dot, the state in a word, and what
 * it means. The word always goes with the dot, so the state never rests on
 * colour alone.
 */
export function SharedCloudAgentState({ shown }: { shown: SharedCloudPresentation }) {
  return (
    <div className="flex items-start gap-2 text-xs" aria-label={`${shown.label}. ${shown.detail}`}>
      <span aria-hidden className={`mt-[4px] size-2 shrink-0 rounded-full ${DOT[shown.tone]}`} />
      <div className="min-w-0">
        <div
          className={`font-medium ${shown.tone === 'problem' ? 'text-destructive' : 'text-foreground'}`}
        >
          {shown.label}
        </div>
        <div className="line-clamp-2 text-foreground-muted">{shown.detail}</div>
        {/* The last-reply line is parked: v3 shows what prod shows, plus the state. */}
      </div>
    </div>
  );
}

/** Says once, at the top of Your Agents, what resting means. */
export function SharedCloudBanner() {
  return (
    <div className="mb-[14px] flex items-start gap-3 rounded-[11px] border border-[var(--blue-4)] bg-[var(--blue-3)] px-[14px] py-3 text-sm">
      <Cloud aria-hidden className="mt-[2px] size-4 shrink-0 text-[var(--blue-11)]" />
      <p>
        <span className="font-medium">Your agents are always available.</span> Agents that have been
        quiet for a while rest, and use almost nothing. Message one and it&apos;s back in a moment.
      </p>
    </div>
  );
}
