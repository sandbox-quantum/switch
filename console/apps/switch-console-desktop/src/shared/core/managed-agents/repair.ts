/**
 * V3b, Repair my cloud and the re-seal after it (design v1.2, security-approved). The pure
 * parts, shared by the main process (which decides and acts) and the renderer (which only
 * shows): the fixed refusal lines, the notes Console keeps, and the decision of which
 * providers it copies by itself and which it asks the owner for.
 */

/** How long after a press this Console may copy a login by itself (security: 2 hours). */
export const RESEAL_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Providers whose login can come from this computer's own sign-in. Claude's own sign-in never can;
 * Claude through Vertex can, from gcloud's file (`vertex`). */
export const THIS_COMPUTER_PROVIDERS = ['codex', 'opencode', 'antigravity'] as const;

/**
 * Where a login given to a machine came from. Never the login itself: only its kind, Vertex's
 * project and region, and where the provider's file names the account, a SHA-256 of that id.
 */
export type LoginSourceRecord = {
  source: 'this-computer' | 'typed' | 'vertex-this-computer' | 'vertex-key';
  project?: string;
  region?: string;
  accountHash?: string;
};

/** This Console's note that the owner pressed Repair here, for one cloud machine. */
export type RepairPressNote = {
  /** The controller the repair revoked. */
  revokedControllerId: string;
  /** Core's own revocation time for it, so later checks never depend on this computer's clock. */
  revokedAt: string | null;
  /** This computer's time of the press, only for the 2-hour window. */
  pressedAt: number;
  /** The first new controller this press copied to; any later one is asked, never copied. */
  copiedControllerId: string | null;
};

export type ResealAction = { provider: string; action: 'copy' | 'ask' };

/**
 * Which providers this Console copies by itself to `controller`, and which it asks for.
 * Copy only when every condition holds (design v1.2):
 * - this Console pressed Repair for the machine within the window;
 * - the controller is new to that press: not the revoked one, created by Core after its
 *   `revokedAt`, and the first one copied to for this press;
 * - the provider's source record says this computer.
 * The local sign-in being readable, and its account matching, is checked when copying.
 */
export function resealPlan(input: {
  now: number;
  press: RepairPressNote | null;
  controller: { id: string; createdAt: string | null };
  providers: readonly string[];
  source: (provider: string) => LoginSourceRecord | null;
}): ResealAction[] {
  const { press, controller } = input;
  const newToPress =
    press !== null &&
    input.now - press.pressedAt <= RESEAL_WINDOW_MS &&
    controller.id !== press.revokedControllerId &&
    press.revokedAt !== null &&
    controller.createdAt !== null &&
    Date.parse(controller.createdAt) > Date.parse(press.revokedAt) &&
    (press.copiedControllerId === null || press.copiedControllerId === controller.id);
  return [...new Set(input.providers)].map((provider) => {
    const record = input.source(provider);
    const fromHere =
      record !== null &&
      (record.source === 'vertex-this-computer'
        ? provider === 'claude'
        : record.source === 'this-computer' &&
          (THIS_COMPUTER_PROVIDERS as readonly string[]).includes(provider));
    return { provider, action: newToPress && fromHere ? 'copy' : 'ask' };
  });
}

export const REPAIR_FAILED = "The repair didn't go through. Try again in a minute.";

/** The fixed line for a refused repair, by status and Core's reason code; never the server's text. */
export function repairRefusal(status: number | undefined, code: string | null): string {
  if (status === 409 && code === 'repair_not_needed')
    return "Your cloud is signing in again, so there's nothing to repair.";
  if ((status === 409 && code === 'controller_revoked') || status === 404)
    return "This cloud can't be repaired from here. Reload and try again.";
  if (status === 403 && code === 'paused_by_switch')
    return "Switch has paused your cloud, so it can't be repaired. Contact your admin.";
  if (status === 403 && code === 'turned_off_by_admin')
    return "Your admin has turned off hosted agents, so your cloud can't be repaired. Ask them to turn it back on.";
  return REPAIR_FAILED;
}

/** What one re-seal run did: the providers copied by itself, and those the owner is asked for. */
export type ResealResult = { copied: string[]; asked: string[] };

/** How the Repair dialog names one provider's login: where it comes from, and the account label
 * this computer's provider file shows, if any (copy `e16e1212`). Never a key, token or path. */
export type LoginSourceView = { kind: 'this-computer' | 'typed'; label?: string };

/** The longest account label the dialog shows. */
export const ACCOUNT_LABEL_MAX = 64;

const EMAIL = /^[^\s@<>"'`]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

/**
 * The non-secret account label in a provider's own sign-in file, for the Repair dialog, or
 * undefined. Only Codex's ChatGPT sign-in names one: the e-mail claim inside its `id_token`. The
 * token is decoded only to read that one claim, never kept, logged or passed on, and anything
 * that isn't a plain e-mail address is dropped, so nothing else in the file can reach the screen.
 * gcloud's file names no account, and a pasted key is never copied, so neither has a label.
 */
export function accountLabelOf(provider: string, credential: string): string | undefined {
  if (provider !== 'codex') return undefined;
  try {
    const parsed = JSON.parse(credential) as { tokens?: { id_token?: unknown } };
    const token = parsed.tokens?.id_token;
    if (typeof token !== 'string') return undefined;
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const claims = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
      )
    ) as { email?: unknown };
    const email = claims.email;
    return typeof email === 'string' && email.length <= ACCOUNT_LABEL_MAX && EMAIL.test(email)
      ? email
      : undefined;
  } catch {
    return undefined;
  }
}

/** One provider's line in the Repair dialog, from this computer's sign-in (copy `e16e1212`). */
export function copiedLoginLine(providerName: string, label: string | undefined): string {
  const shown =
    label && label.length > ACCOUNT_LABEL_MAX ? `${label.slice(0, ACCOUNT_LABEL_MAX - 1)}…` : label;
  return shown
    ? `${providerName}: copied from this computer (${shown})`
    : `${providerName}: copied from this computer`;
}
