import { ArrowUpRight } from 'lucide-react';
import { openExternalUrl } from '@renderer/lib/open-external';
import { SectionLabel } from '@renderer/lib/ui/label';
import { SWITCH_CONSOLE_DOCS_URL } from '@shared/urls';

/**
 * The welcome screen's "Learn more" shelf (CHOO-2022).
 *
 * Every card points at the repository README for now — the docs site does not
 * exist yet, and a card that opens nothing is worse than one that opens the
 * README. Give each its own URL when there is one.
 */
const LEARN_MORE_CARDS: { title: string; url: string }[] = [
  { title: 'Hosting Switch on a SSH device or a cloud', url: SWITCH_CONSOLE_DOCS_URL },
  { title: 'Connecting to message apps', url: SWITCH_CONSOLE_DOCS_URL },
  { title: 'Best ways to use Rooms', url: SWITCH_CONSOLE_DOCS_URL },
];

export function WelcomeLearnMore() {
  return (
    <div className="flex w-full flex-col gap-3 rounded-xl border border-border p-4">
      <div className="flex items-center justify-between">
        <SectionLabel className="text-foreground-tertiary-passive">Learn more</SectionLabel>
        <button
          type="button"
          onClick={() => openExternalUrl(SWITCH_CONSOLE_DOCS_URL, 'Could not open documentation')}
          className="flex items-center gap-0.5 text-xs text-foreground-muted hover:text-foreground"
        >
          Docs
          <ArrowUpRight className="size-3" />
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {LEARN_MORE_CARDS.map((card) => (
          <button
            key={card.title}
            type="button"
            onClick={() => openExternalUrl(card.url, `Could not open “${card.title}”`)}
            // `background-secondary` is the same colour as `background` in the
            // dark theme, so a card painted with it reads as three floating
            // strings of text. The elevated tone differs in both themes, and
            // the border keeps the card's edge legible either way.
            className="flex h-28 items-start rounded-lg border border-border bg-background-secondary-2 p-3 text-left text-sm font-medium text-foreground transition-colors hover:bg-background-secondary-3"
          >
            {card.title}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Attribution strip along the bottom of the welcome screen. */
export function WelcomeFooter() {
  return (
    <div className="flex items-center justify-center gap-2 pt-6 text-xs text-foreground-muted">
      <span>
        Switch is a project of <span className="text-foreground">Flint AI</span> by SandboxAQ
      </span>
      <span aria-hidden>|</span>
      <button
        type="button"
        className="hover:text-foreground"
        onClick={() => openExternalUrl(SWITCH_CONSOLE_DOCS_URL, 'Could not open documentation')}
      >
        Docs
      </button>
      <span aria-hidden>|</span>
      <button
        type="button"
        className="hover:text-foreground"
        onClick={() => openExternalUrl(SWITCH_CONSOLE_DOCS_URL, 'Could not open the repository')}
      >
        GitHub
      </button>
    </div>
  );
}
