import type { LinkedIdentity, RemoteBridge } from '@shared/core/switch-servers/switch-servers';

/**
 * When the "Messaging apps" card should warn that owner-only agents cannot
 * recognise the signed-in user, and which apps to name (CHOO-2137).
 *
 * Kept apart from the card because the interesting part is when it stays quiet.
 * A warning everyone sees is noise, and the two ways this rots — into always-on
 * or into never-on — both look fine on the screen it was written against.
 */

/**
 * The connected messaging apps the signed-in user has claimed no account in,
 * and only when not being recognised there costs them something: they own an
 * agent on this server that is set to answer its owner. Empty means draw no
 * warning.
 *
 * Both inputs are nullable because "not known yet" is not "no". An identity
 * list that has not arrived would make every app look unlinked, and a policy
 * probe that has not answered would make every user look at risk — either read
 * as `false` is the false alarm on every page load that this guards against.
 */
export function unrecognisedMessagingApps({
  bridges,
  identities,
  ownsOwnerAddressedAgent,
}: {
  bridges: RemoteBridge[];
  /** Accounts the user has claimed on this server; null while unknown. */
  identities: LinkedIdentity[] | null;
  /** Whether the user owns an agent here whose policy admits its owner; null
   * while unknown or not asked. */
  ownsOwnerAddressedAgent: boolean | null;
}): RemoteBridge[] {
  if (identities === null || ownsOwnerAddressedAgent !== true) return [];
  return bridges.filter((bridge) => !identities.some((i) => i.bridgeId === bridge.id));
}

/** Whether any listed app has no claimed account — the half of the condition
 * that needs no extra request, and the gate on asking the other half at all.
 * Null identities mean unknown, so nothing is asked yet. */
export function hasUnlinkedMessagingApp(
  bridges: RemoteBridge[],
  identities: LinkedIdentity[] | null
): boolean {
  if (identities === null) return false;
  return bridges.some((bridge) => !identities.some((i) => i.bridgeId === bridge.id));
}

/** The warning, as one sentence naming the apps. Callers pass a non-empty list
 * — an empty one has nothing to warn about. */
export function unrecognisedMessagingAppsMessage(apps: RemoteBridge[]): string {
  return `Agents set to answer only you can’t recognise you in ${joinWithOr(
    apps.map((app) => app.displayName)
  )} — link your account there.`;
}

/** "A", "A or B", "A, B or C". */
function joinWithOr(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/**
 * Whether to offer "which account here is you" straight after connecting an
 * app (CHOO-2137).
 *
 * No, on a platform whose user directory cannot be searched. There, Switch can
 * only name people who have sent it a message — and nobody has sent one to a
 * connection made a second ago, so the search is guaranteed to come back
 * empty. That does not read as "not yet", it reads as "you are not in your own
 * workspace". Linking waits for the server page, by which time someone has
 * messaged the app and there is a name to pick; the warning there is what
 * prompts it.
 */
export function shouldOfferIdentityLinkOnConnect(app: {
  directorySearchSupported: boolean;
}): boolean {
  return app.directorySearchSupported;
}

/**
 * What to say instead, on an app whose directory cannot be searched
 * (CHOO-2173).
 *
 * Withholding the picker is right, but on its own it reads as the step having
 * been skipped or forgotten — the user is left waiting for a prompt that is
 * never coming, and nothing says linking is still owed. This is the ordering
 * they cannot infer: be seen first, link second.
 *
 * Null where the directory can be searched, because there the ordinary flow
 * asks at the moment it is offering to act.
 */
export function identityLinkOrderingNote(app: {
  displayName: string;
  directorySearchSupported: boolean;
}): string | null {
  if (app.directorySearchSupported) return null;
  return `${app.displayName} has no directory of users to search, so Switch does not know you there yet. Add the bot to a chat and send a message in it — you can then link your account from this app’s menu, once you are someone Switch has seen.`;
}
