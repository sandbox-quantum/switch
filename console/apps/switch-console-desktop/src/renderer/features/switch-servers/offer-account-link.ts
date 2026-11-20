import { showModal } from '@renderer/lib/modal/modal-provider';
import { shouldOfferIdentityLinkOnConnect } from './messaging-apps-warning';

/**
 * Step 2 of adding a messaging app: say which account in it is yours
 * (CHOO-2137), so your own agents recognise you there from the first message.
 *
 * Run by the connect dialog itself, so every way into it ends with this step:
 * the server page, a Console link buddy posted, onboarding. It is skippable;
 * the server home keeps offering it while the account stays unlinked.
 *
 * On a platform with no searchable directory there is nothing to offer yet:
 * Switch can only name people who have spoken to it there, and nobody has
 * spoken to a connection made a second ago. How to become linkable is said
 * where it stays put instead: the app's row under Messaging apps, and the
 * buddy's setup checklist. A toast said it once and then vanished.
 */
export function offerAccountLinkAfterConnect(
  workspaceId: string,
  app: { bridgeId: string; displayName: string; directorySearchSupported: boolean }
): void {
  if (shouldOfferIdentityLinkOnConnect(app))
    showModal('claimIdentityModal', { workspaceId, bridgeId: app.bridgeId });
}
