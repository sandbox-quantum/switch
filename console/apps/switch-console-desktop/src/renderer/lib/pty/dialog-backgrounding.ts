/**
 * Whether an open dialog has put this terminal in the background.
 *
 * False when the terminal is inside the dialog. The guard exists so a terminal
 * behind a modal does not eat keystrokes aimed at it; a terminal the modal
 * itself renders is the opposite case, and treating the two alike left an
 * interactive prompt (`gh auth`, waiting on Enter) with no way to answer.
 *
 * With no element to place there is nothing to compare against, so it stays
 * blocked — the previous behaviour, rather than letting keys through on a
 * guess.
 */
export function isBackgroundedByDialog(container: HTMLElement | null): boolean {
  const dialogs = document.querySelectorAll('[role="dialog"]');
  if (dialogs.length === 0) return false;
  if (!container) return true;
  return ![...dialogs].some((dialog) => dialog.contains(container));
}
