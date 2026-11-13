/** The wording for the Workspaces page that is worth testing on its own,
 * apart from the components that render it. */

/** What archiving tells an admin it does, worded from how many people are
 * there now: the usual sentence when there are some, a simpler one when
 * there are none, so it never reads as "Its 0 users keep their accounts". */
export function archiveWorkspaceBody(name: string, users: number): string {
  const usersSentence =
    users === 0
      ? "Nobody is in it."
      : `Its ${users === 1 ? "1 user" : `${users} users`} keep${users === 1 ? "s" : ""} ${
          users === 1 ? "their account" : "their accounts"
        } but can no longer open it,`;
  const agentsSentence =
    users === 0
      ? "Its agents stop, and its messaging apps stop relaying."
      : "its agents stop, and its messaging apps stop relaying.";
  return (
    `${name} stops being somewhere people can work. ${usersSentence} ${agentsSentence} ` +
    "Nothing in it is deleted, and you can restore it from this page."
  );
}

/** What picking a workspace's admins leaves it with, from the count the
 * server answers with after saving. */
export function adminsNotice(name: string, count: number): string {
  if (count === 0) return `${name} now has no workspace admin.`;
  if (count === 1) return `${name} now has 1 admin.`;
  return `${name} now has ${count} admins.`;
}

/** The client-side half of the uniqueness check a workspace's new name gets,
 * creating or renaming it:
 * the server refuses a duplicate too, but this catches the common case
 * without a round trip. Case-insensitive, since "Acme" and "acme" would
 * collide server-side. */
export function duplicateWorkspaceNameError(
  organizationName: string,
  existingNames: readonly string[],
  trimmedName: string,
): string | null {
  if (trimmedName === "") return null;
  const taken = existingNames.find(
    (existing) => existing.trim().toLowerCase() === trimmedName.toLowerCase(),
  );
  return taken === undefined
    ? null
    : `${organizationName} already has a workspace called “${taken}”.`;
}
