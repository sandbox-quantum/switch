import { showModal } from '@renderer/lib/modal/modal-provider';
import { openExternalUrl } from '@renderer/lib/open-external';
import { normalizeExternalHttpUrl } from './external-url';

const HTTP_URL_PATTERN = /^https?:\/\//i;

export function confirmOpenExternalLink(url: string, onError?: (error: unknown) => void): void {
  const normalizedUrl = normalizeExternalHttpUrl(url);

  if (!HTTP_URL_PATTERN.test(normalizedUrl)) {
    return;
  }

  confirmOpenLink(normalizedUrl, onError);
}

/**
 * Shows `url` in full and opens it outside the app only once the person
 * confirms: for an address someone else chose, such as a room's reference,
 * whose name need not say where it goes. The main process still refuses a
 * scheme it does not open.
 */
export function confirmOpenLink(url: string, onError?: (error: unknown) => void): void {
  showModal('confirmExternalLinkModal', {
    url,
    canOpenInSwitchConsoleBrowser: false,
    onSuccess: () => {
      // `onError` used to hang off a rejection that never came: the main
      // process reports a refusal as a value, so it never threw and the
      // callback never ran.
      void openExternalUrl(url, 'Could not open the link').then((opened) => {
        if (!opened) onError?.(new Error(`Could not open ${url}`));
      });
    },
  });
}
