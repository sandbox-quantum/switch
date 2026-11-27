/**
 * `onOpenChange` for a shared (Base UI) dialog: a click outside, Escape and
 * its close button all close it, but while `busy` saving or creating a click
 * outside or Escape leaves it open.
 */
export function closeUnlessBusy(busy: boolean, onClose: () => void) {
  return (open: boolean, details: { reason: string }) => {
    if (open) return;
    if (busy && (details.reason === "outside-press" || details.reason === "escape-key")) return;
    onClose();
  };
}
