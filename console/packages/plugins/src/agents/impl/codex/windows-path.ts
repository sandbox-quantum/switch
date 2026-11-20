/**
 * A Windows PATH value with the folder OpenAI's official Codex installer
 * (`install.ps1`) puts `codex.exe` in, `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`,
 * added after its entries when it is missing, and `path` unchanged otherwise.
 * The installer adds that folder to the user's PATH, which an app or
 * controller started before the install does not see. It goes last, as it
 * does in a terminal opened since: a `codex` already on PATH (npm's, say)
 * still wins, so Switch Console and the agent controller resolve the same one.
 */
export function withWindowsCodexBinDir(path: string, localAppData: string | undefined): string {
  if (!localAppData) return path;
  const codexBin = `${localAppData.replace(/[\\/]+$/, '')}\\Programs\\OpenAI\\Codex\\bin`;
  const entries = path.split(';').filter(Boolean);
  const present = entries.some(
    (entry) => entry.replace(/[\\/]+$/, '').toLowerCase() === codexBin.toLowerCase()
  );
  return present ? path : [...entries, codexBin].join(';');
}
