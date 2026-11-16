import type { ReactNode } from 'react';

/** switch-buddy's few lines about itself. */
export function buddyIntroLines(firstName: string | null): string[] {
  return [
    `Hey${firstName ? ` ${firstName}` : ''}! I’ll be your assistant for everything Switch.`,
    'Like creating new agents, and bringing humans and agents together.',
    '…and setting up and managing your workflows, permissions & guardrails!',
  ];
}

/** The lines, as bubbles, all at once. */
export function BuddyIntroLines({ firstName }: { firstName: string | null }) {
  return (
    <IntroBubbles>
      {buddyIntroLines(firstName).map((line) => (
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
