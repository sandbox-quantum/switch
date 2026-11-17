import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { Button } from '../primitives/button';
import { Spinner } from '../primitives/spinner';

/**
 * How to start the buddy, as the chat's last turn: a card asking for an AI
 * provider. With one already signed in on this computer, each is a tile to
 * start it with, beside a link to the others; no Skip, though the flow's own
 * way out stays at the top. With none, set one up or skip.
 */
export function BuddyStartCard({
  checking,
  ready,
  starting,
  onStart,
  onSetUp,
  onSkip,
  icon,
  readyTag,
  info,
}: {
  checking: boolean;
  ready: { id: string; name: string }[];
  starting: string | null;
  onStart: (providerId: string) => void;
  onSetUp: () => void;
  onSkip: () => void;
  /** A provider's icon, drawn as the app draws it. */
  icon: (providerId: string, size: number) => ReactNode;
  /** What a ready provider's tile says: where it is signed in. */
  readyTag: string;
  /** Beside the heading: what an AI provider is, where the app explains it. */
  info: ReactNode;
}) {
  const busy = starting !== null;
  const shown = checking ? 'checking' : ready.length > 0 ? 'signed-in' : 'none';
  return (
    <section
      aria-labelledby="buddy-start-heading"
      className="flex max-w-full flex-col gap-3 rounded-2xl bg-foreground/[0.04] p-3 emdark:bg-background-2/60"
    >
      <h2
        id="buddy-start-heading"
        className="flex items-center gap-1.5 px-1 text-sm font-medium text-foreground"
      >
        Pick an AI provider to get started
        {info}
      </h2>
      <motion.div
        key={shown}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 260, damping: 26 }}
        className="flex flex-wrap items-center gap-3"
      >
        {shown === 'checking' ? (
          <span className="flex h-9 items-center gap-1.5 px-1 text-xs text-foreground-muted">
            <Spinner className="size-3" />
            Checking AI providers…
          </span>
        ) : shown === 'signed-in' ? (
          <>
            {ready.map((provider) => (
              <button
                key={provider.id}
                type="button"
                onClick={() => onStart(provider.id)}
                disabled={busy}
                className="flex w-40 flex-col items-start gap-3 rounded-xl bg-background p-3 text-left shadow-sm transition-shadow outline-none hover:shadow-md focus-visible:ring-2 focus-visible:ring-border-primary enabled:cursor-pointer disabled:opacity-60 emdark:bg-background-1"
              >
                {starting === provider.id ? <Spinner className="size-5" /> : icon(provider.id, 20)}
                <span className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">{provider.name}</span>
                  <span className="text-xs text-foreground-success">{readyTag}</span>
                </span>
              </button>
            ))}
            <span className="text-sm text-foreground-muted">
              or{' '}
              <button
                type="button"
                onClick={onSetUp}
                disabled={busy}
                className="rounded-sm text-foreground underline underline-offset-2 outline-none hover:text-foreground-muted focus-visible:ring-2 focus-visible:ring-border-primary enabled:cursor-pointer disabled:opacity-60"
              >
                use other providers
              </button>
            </span>
          </>
        ) : (
          <>
            <Button onClick={onSetUp}>Set up AI provider</Button>
            <Button variant="ghost" onClick={onSkip}>
              Skip
            </Button>
          </>
        )}
      </motion.div>
    </section>
  );
}
