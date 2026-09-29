/** What an error says, whatever was thrown. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Why a command on a host failed: its own stderr when it wrote any, which
 * says more than the exit status it wraps, else what was thrown. */
export function commandFailure(error: unknown): string {
  const stderr = (error as { stderr?: string } | undefined)?.stderr?.trim();
  return stderr || errorText(error);
}
