import { toast } from '@renderer/lib/hooks/use-toast';
import { showModal } from '@renderer/lib/modal/modal-provider';
import {
  identityLinkOrderingNote,
  shouldOfferIdentityLinkOnConnect,
} from './messaging-apps-warning';

/**
 * Step 2 of adding a messaging app: say which account in it is yours
 * (CHOO-2137), so your own agents recognise you there from the first message.
 *
 * Run by the connect dialog itself, so every way into it ends with this step:
 * the server page, a Console link buddy posted, onboarding. It is skippable;
 * the server home keeps offering it while the account stays unlinked.
 *
 * On a platform with no searchable directory there is no picker: Switch can
 * only name people who have spoken to it there, and nobody has spoken to a
 * connection made a second ago, so the search would be guaranteed empty and
 * teach the user they are not in their own workspace. It says how linking
 * works there instead, rather than closing on nothing and leaving the step
 * looking forgotten.
 */
export function offerAccountLinkAfterConnect(
  workspaceId: string,
  app: { bridgeId: string; displayName: string; directorySearchSupported: boolean }
): void {
  if (shouldOfferIdentityLinkOnConnect(app)) {
    showModal('claimIdentityModal', { workspaceId, bridgeId: app.bridgeId });
    return;
  }
  const note = identityLinkOrderingNote(app);
  if (note !== null) toast({ title: `Link your ${app.displayName} account`, description: note });
}
