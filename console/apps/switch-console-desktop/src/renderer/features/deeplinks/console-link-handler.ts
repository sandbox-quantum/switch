/**
 * Who opens a Console page link clicked in the app, set once the app is up
 * (`ConsoleLinkListener`). Kept apart from the opener so what renders a link,
 * such as chat markdown, does not load the stores the opener needs.
 */
let handler: ((url: string) => void) | null = null;

export function setConsoleLinkHandler(next: ((url: string) => void) | null): void {
  handler = next;
}

/** Open a Console page link; says so in the log when nothing can yet. */
export function followConsoleLink(url: string): void {
  if (handler === null) {
    console.warn('[deeplink] a Console link was clicked before the app could open it', { url });
    return;
  }
  handler(url);
}
