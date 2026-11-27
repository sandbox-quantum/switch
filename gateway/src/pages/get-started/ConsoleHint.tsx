import { GET_SWITCH_CONSOLE_URL } from "../templates/OpenInConsoleDialog";

/**
 * Where else agents can run, for someone whose agents run on their Switch
 * Cloud device: `lead` says what runs there (null where the page already
 * says), and the rest points to Switch Console for running agents on their
 * own computer.
 */
export function ConsoleHint({ lead }: { lead: string | null }) {
  return (
    <p className="text-xs text-foreground-muted">
      {lead && `${lead} `}To run agents on your own computer, use{" "}
      <a
        href={GET_SWITCH_CONSOLE_URL}
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2 hover:text-foreground"
      >
        Switch Console
      </a>
      .
    </p>
  );
}
