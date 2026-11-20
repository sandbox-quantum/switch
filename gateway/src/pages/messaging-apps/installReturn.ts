/** Where the dashboard goes back to once an install it started is connected. */
const KEY = "switch.install-return";

/** Remembers the page an install starts from, as it leaves for the platform. */
export function rememberInstallReturn(path: string): void {
  sessionStorage.setItem(KEY, path);
}

/** The page to go back to, read once; Messaging apps when none was kept. */
export function takeInstallReturn(): string {
  const kept = sessionStorage.getItem(KEY);
  sessionStorage.removeItem(KEY);
  // Only a path on this dashboard, never another site.
  return kept !== null && kept.startsWith("/") && !kept.startsWith("//")
    ? kept
    : "/settings/messaging-apps";
}
