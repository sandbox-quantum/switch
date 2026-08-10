/**
 * `allowpopups` for the embedded room `<webview>`.
 *
 * Spread rather than written as a JSX prop for two reasons, both load-bearing:
 *
 *  - React's own typing declares `allowpopups` as a boolean, but React does
 *    NOT emit an attribute for `allowpopups={true}` on this element — the
 *    attribute is simply absent, which Electron reads as popups blocked. It
 *    has to reach the DOM as a string.
 *  - Setting it later via a ref is too late: the guest attaches when the
 *    element enters the DOM, and its popup policy is fixed at that point.
 *
 * Without the attribute, Electron blocks the guest's popups before they reach
 * the window-open handler, so every external link in a message silently does
 * nothing. Covered by webview-allowpopups.test.tsx.
 */
export const WEBVIEW_ALLOW_POPUPS: Record<string, string> = { allowpopups: 'true' };
