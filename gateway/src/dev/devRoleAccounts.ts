import { ApiError, type TenantMembership, fetchSession, login, switchTenant } from "../data/api";
import { clearPendingInvite } from "../data/sessionState";

/** One of the accounts `just seed-dev-roles` makes, one per permission level. */
export interface DevAccount {
  role: "operator" | "org_admin" | "workspace_admin" | "member";
  label: string;
  email: string;
  password: string;
}

/** Where the dev server serves them (`scripts/dev-role-accounts.mjs`). No
 * build serves it, and `scripts/check-no-dev-tools.mjs` refuses a build whose
 * code names it. */
export const DEV_ROLE_ACCOUNTS_PATH = "/__dev/role-accounts";

/** The seeded accounts, or null when `just seed-dev-roles` has not been run. */
export async function fetchDevAccounts(): Promise<DevAccount[] | null> {
  const res = await fetch(DEV_ROLE_ACCOUNTS_PATH, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Vite could not hand out the test accounts: ${await res.text()}`);
  }
  const body = (await res.json()) as { accounts: DevAccount[] };
  return body.accounts;
}

export interface Note {
  severity: "info" | "error";
  text: string;
}

/** Sign in as `account`, an ordinary password sign-in, then go back into
 * `workspace` where it may open it, so a page can be checked as each role in
 * turn. Throws only when the sign-in itself fails, which leaves the session
 * as it was; after that, returns what to tell the person, if anything. */
export async function signInAs(
  account: DevAccount,
  workspace: TenantMembership | null,
): Promise<Note | null> {
  // As on signing out: the next account must not inherit an invitation.
  clearPendingInvite();
  await login(account.email, account.password);
  if (workspace === null) return null;
  try {
    const session = await fetchSession();
    if (session?.tenant?.id !== workspace.id) await switchTenant(workspace.id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      return { severity: "info", text: `${account.label} can't open ${workspace.name}.` };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return {
      severity: "error",
      text: `Signed in as ${account.label}, but could not go back to ${workspace.name}: ${reason}`,
    };
  }
  return null;
}

const NOTE_KEY = "switch.devRoleNote";

/** A note for the page the switch reloads onto. */
export function storeNote(note: Note): void {
  window.sessionStorage.setItem(NOTE_KEY, JSON.stringify(note));
}

export function takeNote(): Note | null {
  const stored = window.sessionStorage.getItem(NOTE_KEY);
  window.sessionStorage.removeItem(NOTE_KEY);
  return stored === null ? null : (JSON.parse(stored) as Note);
}
