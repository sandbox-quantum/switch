import { showModal } from '@renderer/lib/modal/modal-provider';
import { openExternalUrl } from '@renderer/lib/open-external';
import { normalizeExternalHttpUrl } from './external-url';

const HTTP_URL_PATTERN = /^https?:\/\//i;
/** An email link: asked about like a web link, then handed to the mail app. */
const MAILTO_PATTERN = /^mailto:/i;

export function confirmOpenExternalLink(url: string, onError?: (error: unknown) => void): void {
  const trimmed = url.trim();
  const normalizedUrl = MAILTO_PATTERN.test(trimmed) ? trimmed : normalizeExternalHttpUrl(url);

  if (!HTTP_URL_PATTERN.test(normalizedUrl) && !MAILTO_PATTERN.test(normalizedUrl)) {
    return;
  }

  showModal('confirmExternalLinkModal', {
    url: normalizedUrl,
    canOpenInSwitchConsoleBrowser: false,
    onSuccess: () => {
      // `onError` used to hang off a rejection that never came: the main
      // process reports a refusal as a value, so it never threw and the
      // callback never ran.
      void openExternalUrl(normalizedUrl, 'Could not open the link').then((opened) => {
        if (!opened) onError?.(new Error(`Could not open ${normalizedUrl}`));
      });
    },
  });
}
