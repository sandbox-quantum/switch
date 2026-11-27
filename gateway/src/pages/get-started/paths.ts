/** Where getting started on the web lives. Kept apart so the shell can name it without loading the page. */
export const GET_STARTED = "/get-started";

/** Remembers, per person and workspace, that the dashboard already sent them to Get started once. */
export function sentKey(userId: string, tenantId: string): string {
  return `switch.get-started.sent:${userId}:${tenantId}`;
}

/** Whether this person was already sent to Get started in this workspace, read without loading the page. */
export function sentToGetStarted(userId: string, tenantId: string): boolean {
  return localStorage.getItem(sentKey(userId, tenantId)) !== null;
}
