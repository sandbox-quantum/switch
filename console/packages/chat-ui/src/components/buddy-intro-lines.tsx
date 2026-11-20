import type { ReactNode } from 'react';

/**
 * switch-buddy's few lines about itself: who it is, what a room is, and what
 * one is for — concrete enough that someone new to Switch pictures using it.
 */
export function buddyIntroLines(
  firstName: string | null,
  /** Where the person is meeting it, for "or right here in …": `Console`, or `the dashboard` on the web. */
  here: string
): string[] {
  return [
    `Hey${firstName ? ` ${firstName}` : ''}! I’ll be your assistant for everything Switch Rooms.`,
    `In Switch Rooms, your team and AI agents work together in rooms: shared spaces in Slack, Teams, Discord, Telegram, or right here in ${here}.`,
    'Like a code-review room where an agent reviews every pull request, or a support room where agents triage incoming questions.',
  ];
}

/** The lines, as bubbles, all at once. */
export function BuddyIntroLines({ firstName, here }: { firstName: string | null; here: string }) {
  return (
    <IntroBubbles>
      {buddyIntroLines(firstName, here).map((line) => (
        <IntroBubble key={line}>{line}</IntroBubble>
      ))}
    </IntroBubbles>
  );
}

export function IntroBubbles({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-fit max-w-[540px] flex-col items-start gap-3">{children}</div>
  );
}

export const INTRO_BUBBLE_CLASS =
  'rounded-2xl bg-background px-4 py-3 text-sm font-medium text-foreground shadow-sm emdark:bg-background-2';

function IntroBubble({ children }: { children: ReactNode }) {
  return <p className={INTRO_BUBBLE_CLASS}>{children}</p>;
}
