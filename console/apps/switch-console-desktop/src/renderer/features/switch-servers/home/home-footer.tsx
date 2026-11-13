import { openExternalUrl } from '@renderer/lib/open-external';
import { SWITCH_CONSOLE_DOCS_URL, SWITCH_CONSOLE_REPO_URL } from '@shared/urls';

/** Attribution strip along the bottom of Home. */
export function HomeFooter() {
  return (
    <div className="flex items-center justify-center gap-2 py-4 text-xs text-foreground-muted">
      <span>Switch Rooms is a product of SandboxAQ</span>
      <span aria-hidden>|</span>
      <button
        type="button"
        className="hover:text-foreground"
        onClick={() => openExternalUrl(SWITCH_CONSOLE_DOCS_URL, 'Could not open documentation')}
      >
        Docs
      </button>
      <span aria-hidden>|</span>
      <button
        type="button"
        className="hover:text-foreground"
        onClick={() => openExternalUrl(SWITCH_CONSOLE_REPO_URL, 'Could not open the repository')}
      >
        GitHub
      </button>
    </div>
  );
}
