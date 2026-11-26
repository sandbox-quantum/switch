import "@switch-console/chat-ui/theme.css";
import { SHARED_UI_CLASS } from "@switch-console/chat-ui/model/scope";
import type { ReactNode } from "react";

/** The full-width black button that moves a sign-in or sign-up card on. */
export const PRIMARY_BUTTON =
  "h-10 w-full border-transparent bg-neutral-900 text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200";
/** A full-width secondary button on the card, such as a sign-in provider's. */
export const OUTLINE_BUTTON =
  "h-10 w-full gap-2 border-black/10 bg-white/90 text-neutral-900 hover:bg-white dark:border-white/15 dark:bg-white/5 dark:text-white dark:hover:bg-white/10";
export const CARD_INPUT = "h-10 bg-white/90 px-3 dark:bg-black/30";
export const CARD_LABEL = "font-medium text-foreground";
export const TEXT_LINK =
  "cursor-pointer text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-300";

const WIDTH = { md: "max-w-[420px]", lg: "max-w-[640px]", xl: "max-w-[920px]" } as const;

/**
 * The frame of the sign-in, sign-up and first-run pages: a soft gradient
 * filling the window, Switch's logo, a heading, and a translucent card.
 */
export default function AuthLayout({
  heading,
  subheading,
  width = "md",
  footer,
  children,
}: {
  heading: string;
  subheading?: ReactNode;
  width?: keyof typeof WIDTH;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={`${SHARED_UI_CLASS} flex min-h-screen flex-col items-center bg-[linear-gradient(to_top_right,#ff9370_0%,#f0a98f_28%,#c9bcb6_55%,#a5c9d3_78%,#8ecbdc_100%)] px-4 pb-6 pt-16 text-foreground dark:bg-[linear-gradient(to_top_right,#4b2419_0%,#3a2826_30%,#22292f_58%,#16313b_80%,#0e3946_100%)]`}
    >
      <img src="/switch_logo_dark.svg" alt="Switch" width={44} height={44} className="dark:hidden" />
      <img
        src="/switch_logo_light.svg"
        alt=""
        aria-hidden
        width={44}
        height={44}
        className="hidden dark:block"
      />
      <h1 className="mt-6 text-center text-2xl font-semibold tracking-tight text-neutral-900 dark:text-white">
        {heading}
      </h1>
      {subheading && (
        <p className="mt-2 max-w-md text-center text-sm text-neutral-700 dark:text-neutral-300">
          {subheading}
        </p>
      )}
      <main
        className={`mt-8 w-full ${WIDTH[width]} rounded-3xl border border-white/60 bg-white/55 p-8 shadow-[0_12px_48px_rgba(40,20,10,0.12)] backdrop-blur-xl motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300 sm:p-10 dark:border-white/10 dark:bg-neutral-900/55 dark:shadow-[0_12px_48px_rgba(0,0,0,0.45)]`}
      >
        {children}
      </main>
      {footer && (
        <footer className="mt-auto pt-10 text-center text-sm text-neutral-800 dark:text-neutral-300">
          {footer}
        </footer>
      )}
    </div>
  );
}

const SIGN_UP_STEPS = ["Account", "Workspace", "Team", "License"];

/** Where a new person is in signing up: account, workspace, team, license. */
export function SignUpSteps({ active }: { active: number }) {
  return (
    <ol className="mb-6 flex items-center gap-2 text-xs" aria-label="Sign-up steps">
      {SIGN_UP_STEPS.map((label, index) => (
        <li
          key={label}
          aria-current={index === active ? "step" : undefined}
          className="flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center"
        >
          <span
            className={`h-1 w-full rounded-full ${
              index <= active ? "bg-neutral-900 dark:bg-white" : "bg-black/10 dark:bg-white/15"
            }`}
          />
          <span
            className={
              index === active
                ? "font-medium text-foreground"
                : "text-neutral-600 dark:text-neutral-400"
            }
          >
            {label}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** "OR" between the email form and the sign-in providers. */
export function OrDivider() {
  return (
    <div className="flex items-center gap-4 text-xs uppercase text-neutral-500 dark:text-neutral-400">
      <span className="h-px flex-1 bg-black/10 dark:bg-white/15" />
      or
      <span className="h-px flex-1 bg-black/10 dark:bg-white/15" />
    </div>
  );
}
