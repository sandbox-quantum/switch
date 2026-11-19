/**
 * Whether the name in the New agent form belongs to another agent on the
 * server, which greys out "Add agent" and shows the clash under the name.
 *
 * `takenNames` is the server's live agent list, and the agent this form is
 * creating joins that list as soon as the server registers it, often while
 * the form is still finishing setup or closing. Without the two checks below
 * the form would briefly report its own new agent as a clash, so the check
 * pauses while a create is in flight and never counts the name this form
 * registered.
 */
export function isAgentNameTaken(args: {
  name: string;
  nameIsValid: boolean;
  takenNames: ReadonlySet<string>;
  creating: boolean;
  createdName: string | null;
}): boolean {
  const { name, nameIsValid, takenNames, creating, createdName } = args;
  if (!nameIsValid || creating || name === createdName) return false;
  return takenNames.has(name);
}
