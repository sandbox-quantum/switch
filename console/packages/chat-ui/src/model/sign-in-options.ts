export type SignInButton = {
  /** The server's sign-in option, or null for its one SSO button. */
  id: string | null;
  label: string;
};

/** One button per sign-in option the server lists (Google, GitHub…), or one
 * labelled for its identity provider when it lists none. */
export function oidcSignInButtons(
  options: readonly { id: string; label: string }[],
  providerLabel: string | null
): SignInButton[] {
  return options.length > 0 ? [...options] : [{ id: null, label: providerLabel ?? 'SSO' }];
}
