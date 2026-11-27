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
