import type { ReactNode } from 'react';

/** switch-buddy's few lines about itself, as Meet switch-buddy shows them. */
export function BuddyIntroLines({ firstName }: { firstName: string | null }) {
  return (
    <div className="mx-auto flex w-full max-w-[540px] flex-col items-start gap-3">
      <Line>
        Hey{firstName ? ` ${firstName}` : ''}! I’ll be your assistant for everything Switch.
      </Line>
      <Line>I can create new agents for you.</Line>
      <Line>Also bring your human and agent teams into different rooms.</Line>
      <Line>…and set up and manage your workflows, permissions and guardrails!</Line>
      <Line>Ready to go?</Line>
    </div>
  );
}

function Line({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-2xl bg-background px-4 py-3 text-sm text-foreground shadow-sm">
      {children}
    </p>
  );
}
