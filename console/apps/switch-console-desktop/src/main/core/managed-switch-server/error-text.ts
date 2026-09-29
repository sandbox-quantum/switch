export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The command's stderr when it wrote any, else what was thrown. */
export function commandFailure(error: unknown): string {
  const stderr = (error as { stderr?: string } | undefined)?.stderr?.trim();
  return stderr || errorText(error);
}
