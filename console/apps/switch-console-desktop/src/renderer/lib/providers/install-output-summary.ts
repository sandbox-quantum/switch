/** npm's closing lines point at its log file, not at what went wrong. */
const FOOTER =
  /complete log of this run|[\\/]_logs[\\/]|log files were not written|rerun the command with/i;
const FAILURE = /\berror\b|ERR!|failed|fatal|denied|could not|cannot|unable|not found/i;

/**
 * Where a PowerShell error record says what failed (`At line:1 char:47`, or
 * `At C:\path\script.ps1:12 char:5` for a script). Everything between the
 * record's first line and this one is its message, which PowerShell wraps at
 * the width of the console it is given.
 */
const POWERSHELL_POSITION = /^At (?:line:\d+|.+:\d+) char:\d+/;

/** How many wrapped lines a PowerShell error message may run on for. */
const POWERSHELL_MESSAGE_MAX_LINES = 6;

const MAX_LENGTH = 400;

/**
 * The line of an install command's output that best says why it failed: the
 * first one that reads like an error, skipping npm's log-file footer, or else
 * the last line. A PowerShell error message wrapped over several lines is
 * joined back into one. Capped so a long one can't fill the page.
 */
export function installOutputSummary(output: string): string | null {
  const lines = output
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part && !FOOTER.test(part));
  const index = lines.findIndex((part) => FAILURE.test(part));
  const line = index === -1 ? lines.at(-1) : withWrappedLines(lines, index);
  if (!line) return null;
  return line.length > MAX_LENGTH ? `${line.slice(0, MAX_LENGTH)}…` : line;
}

function withWrappedLines(lines: string[], index: number): string {
  const end = lines
    .slice(index + 1, index + 1 + POWERSHELL_MESSAGE_MAX_LINES)
    .findIndex((part) => POWERSHELL_POSITION.test(part));
  return lines.slice(index, end === -1 ? index + 1 : index + 1 + end).join(' ');
}
