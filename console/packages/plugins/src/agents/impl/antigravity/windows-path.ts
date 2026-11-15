/**
 * A Windows PATH value with the folder Google's Antigravity installer puts
 * `agy.exe` in, `%LOCALAPPDATA%\agy\bin`, added after its entries when it is
 * missing, and `path` unchanged otherwise. The installer adds that folder to
 * the user's PATH, which an app or controller started before the install does
 * not see. It goes last, as it does in a terminal opened since: an `agy`
 * already on PATH (Scoop's, say) still wins, so Switch Console and the agent
 * controller resolve the same one.
 */
export function withWindowsAgyBinDir(path: string, localAppData: string | undefined): string {
  if (!localAppData) return path;
  const agyBin = `${localAppData.replace(/[\\/]+$/, '')}\\agy\\bin`;
  const entries = path.split(';').filter(Boolean);
  const present = entries.some(
    (entry) => entry.replace(/[\\/]+$/, '').toLowerCase() === agyBin.toLowerCase()
  );
  return present ? path : [...entries, agyBin].join(';');
}
