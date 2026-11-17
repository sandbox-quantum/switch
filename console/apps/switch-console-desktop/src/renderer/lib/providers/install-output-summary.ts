/** npm's closing lines point at its log file, not at what went wrong. */
const FOOTER =
  /complete log of this run|[\\/]_logs[\\/]|log files were not written|rerun the command with/i;
const FAILURE = /\berror\b|ERR!|failed|fatal|denied|could not|cannot|unable|not found/i;

/**
 * The line of an install command's output that best says why it failed: the
 * first one that reads like an error, skipping npm's log-file footer, or else
 * the last line. Capped so a long one can't fill the page.
 */
export function installOutputSummary(output: string): string | null {
  const lines = output
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part && !FOOTER.test(part));
  const line = lines.find((part) => FAILURE.test(part)) ?? lines.at(-1);
  if (!line) return null;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
