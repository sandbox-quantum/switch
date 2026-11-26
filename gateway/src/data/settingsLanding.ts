/** Where a workspace switch lands, and where the settings areas send someone
 * who arrives without naming a page: back to the page they last had open, or,
 * after switching workspace from a settings page, to that same page in the new
 * workspace. Either way the area checks the page against what they may open
 * there, and falls back to its first page; see `SettingsIndex`. */

export type SettingsArea = "workspace" | "organization";

const AFTER_SWITCH_KEY = "switch.settings.afterSwitch";
const LAST_PAGE_KEY = "switch.settings.lastPage";

/** The lists a switch stays on: each shows the new workspace's own. */
const LIST_PAGES: readonly string[] = ["/agents", "/rooms", "/templates", "/resources", "/connectors"];

// `/usage` stays where it is until Usage & budget is rebuilt, but sits in
// Workspace settings.
function inSettings(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/") || pathname === "/usage";
}

/** Where to load after switching workspace from `pathname`. A list stays
 * where it is and a settings page is carried across; anything else, such as
 * one agent or room, starts again from the landing page, because what it
 * showed belonged to the workspace being left. */
export function landingAfterSwitch(pathname: string): string {
  if (LIST_PAGES.includes(pathname)) return pathname;
  if (!inSettings(pathname)) return "/";
  window.sessionStorage.setItem(AFTER_SWITCH_KEY, pathname);
  return "/settings";
}

/** The settings page a workspace switch carried across. Read while
 * rendering, and cleared once the area has opened (`clearLandingAfterSwitch`)
 * rather than on the read, which React may repeat. */
export function landingCarriedAcross(): string | null {
  return window.sessionStorage.getItem(AFTER_SWITCH_KEY);
}

export function clearLandingAfterSwitch(): void {
  window.sessionStorage.removeItem(AFTER_SWITCH_KEY);
}

export function rememberSettingsPage(area: SettingsArea, path: string): void {
  window.localStorage.setItem(`${LAST_PAGE_KEY}.${area}`, path);
}

export function rememberedSettingsPage(area: SettingsArea): string | null {
  return window.localStorage.getItem(`${LAST_PAGE_KEY}.${area}`);
}
