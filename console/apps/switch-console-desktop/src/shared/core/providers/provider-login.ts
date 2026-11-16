/**
 * Signing a provider's CLI in on this computer, by running its own sign-in
 * command (`claude auth login`, `codex login`, ...). The command opens the
 * provider's page in the browser, or prints a link to open; what it writes is
 * relayed line by line so the page can show it.
 */
export type ProviderLoginLine = { attemptId: string; line: string };

/**
 * How a sign-in attempt ended: `exitCode` 0 when the command says it signed
 * in, `error` when it could not be started or was cancelled.
 */
export type ProviderLoginExit = {
  attemptId: string;
  exitCode: number | null;
  error: string | null;
};

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/g;

/** The links a sign-in command printed, in order and without repeats. */
export function linksIn(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const line of lines) for (const match of line.matchAll(URL_PATTERN)) seen.add(match[0]);
  return [...seen];
}

const ASKS_FOR_CODE = /paste (the )?(authentication |auth )?code/i;
/** An authorize link for the flow that ends on a page showing a code to paste. */
const CODE_FLOW_LINK = /[?&]code=true(&|$)/;

/**
 * Whether the command may wait for a code typed in. Claude Code's sign-in
 * page can end by showing one to paste, when its callback to this computer did
 * not happen; it asks with a prompt that ends no line (so it arrives only once
 * the code is sent), after printing the link for that flow.
 */
export function asksForCode(lines: readonly string[]): boolean {
  return (
    lines.some((line) => ASKS_FOR_CODE.test(line)) ||
    linksIn(lines).some((link) => CODE_FLOW_LINK.test(link))
  );
}
