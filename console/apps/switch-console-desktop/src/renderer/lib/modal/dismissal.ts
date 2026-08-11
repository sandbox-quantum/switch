/**
 * Decides whether a modal should close in response to a Base UI Dialog
 * `onOpenChange(false)` event.
 *
 * Passive dismissals are the backdrop click (`outside-press`) and the Escape
 * key (`escape-key`); every other reason (close button, imperative close) is a
 * deliberate close and always goes through.
 *
 * - An active close guard blocks both passive dismissals (used while a flow is
 *   mid-operation and must not be interrupted).
 * - A modal with `dismissOnOutsideClick: false` blocks the backdrop click only;
 *   Escape still closes it. This keeps data-entry modals from discarding input
 *   on a stray outside click while leaving the keyboard escape hatch intact.
 */
export function shouldCloseModalOnDismiss(params: {
  reason: string;
  closeGuardActive: boolean;
  dismissOnOutsideClick: boolean;
}): boolean {
  const { reason, closeGuardActive, dismissOnOutsideClick } = params;
  const isPassiveDismiss = reason === 'outside-press' || reason === 'escape-key';
  if (closeGuardActive && isPassiveDismiss) return false;
  if (reason === 'outside-press' && !dismissOnOutsideClick) return false;
  return true;
}
