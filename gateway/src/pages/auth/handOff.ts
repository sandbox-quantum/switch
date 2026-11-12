import type { AuthConfig, OidcLoginOption } from "../../data/api";

/** A sign-in button for the identity provider. `id` is the login option it
 * starts, or null for the single button that leaves the choice to the
 * provider. */
export interface SsoButton {
  id: string | null;
  label: string;
}

/** The identity provider's buttons: one per configured login option, or a
 * single one when none are configured. None while OIDC is off. */
export function ssoButtons(config: AuthConfig): SsoButton[] {
  if (!config.oidc_enabled) return [];
  if (config.oidc_login_options.length === 0) {
    return [{ id: null, label: config.oidc_provider_label ?? "SSO" }];
  }
  return config.oidc_login_options.map((option: OidcLoginOption) => ({
    id: option.id,
    label: option.label,
  }));
}

/** The one way to sign in, when there is only one to choose: no password
 * form and a single identity-provider button. The sign-in page then goes
 * straight there, as an identity provider's own hosted page is the sign-in. */
export function onlyWayIn(config: AuthConfig): SsoButton | null {
  if (config.password_login_enabled) return null;
  const buttons = ssoButtons(config);
  return buttons.length === 1 ? buttons[0] : null;
}

/** Leaves for the identity provider, in place of the sign-in page, so Back
 * does not return to a page that would only leave again. */
export function leaveFor(url: string): void {
  window.location.replace(url);
}
