import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { cn } from '../model/cn';
import { Button } from '../primitives/button';
import { Spinner } from '../primitives/spinner';

/**
 * One AI provider to pick for switch-buddy, as a card: its icon, its name, a
 * short tag saying where it stands, and, for one that needs a login first, a
 * button for it inside the card. What the tag says, and what picking it does,
 * is the page's.
 */
export function ProviderChoiceCard({
  icon,
  name,
  tag,
  tone,
  selected,
  disabled,
  onSelect,
  signIn,
}: {
  icon: ReactNode;
  name: string;
  tag: string;
  /** `ready` draws the tag green, `checking` with a spinner. */
  tone: 'ready' | 'checking' | 'plain';
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  /** Opens the provider's login; null for one that needs none or cannot be given one. */
  signIn: (() => void) | null;
}) {
  return (
    <li className="relative list-none">
      <button
        type="button"
        aria-pressed={selected}
        disabled={disabled}
        onClick={onSelect}
        className={cn(
          'flex h-full w-full flex-col items-start gap-3 rounded-xl border bg-background/80 p-4 text-left disabled:opacity-60',
          selected ? 'border-foreground' : 'border-border hover:bg-[var(--sel-soft)]'
        )}
      >
        {icon}
        <span className="space-y-0.5">
          <span className="block text-sm font-medium text-foreground">{name}</span>
          <span
            className={cn(
              'flex items-center gap-1.5 text-xs',
              tone === 'ready' ? 'text-emerald-600' : 'text-foreground-muted'
            )}
          >
            {tone === 'checking' && <Spinner className="size-3" />}
            {tag}
          </span>
        </span>
      </button>
      {signIn && (
        <Button
          variant="outline"
          size="xs"
          className="absolute top-3 right-3"
          aria-label={`Sign in to ${name}`}
          onClick={signIn}
        >
          Sign in
        </Button>
      )}
    </li>
  );
}

/**
 * What the picked provider needs next, kept in view pinned to the bottom of
 * the page just above its buttons: below a long grid it would be off-screen,
 * and a click on a card would seem to do nothing. It slides in as a provider
 * is picked, so the eye follows it.
 */
export function ProviderActionPanel({
  providerId,
  children,
}: {
  /** Which provider it is for, so picking another slides it in again. */
  providerId: string;
  children: ReactNode;
}) {
  const reduced = useReducedMotion() ?? false;
  return (
    <motion.div
      key={providerId}
      data-slot="provider-action"
      initial={reduced ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 320, damping: 30 }}
      className="sticky bottom-0 z-10 flex flex-col gap-3 rounded-xl border border-border bg-background p-4 shadow-lg"
    >
      {children}
    </motion.div>
  );
}
