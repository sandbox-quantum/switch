import { detectPlatform } from '@tanstack/react-hotkeys';
import { BookOpen, ExternalLink, PanelLeft, Search } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { NavButtons } from '@renderer/lib/components/nav-buttons';
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { useWorkspaceSlots } from '@renderer/lib/layout/workspace-slots';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Button } from '@renderer/lib/ui/button';
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { cn } from '@renderer/utils/utils';
import { SWITCH_CONSOLE_DOCS_URL, SWITCH_TRUST_URL } from '@shared/urls';

const isMac = detectPlatform() === 'mac';

/**
 * Opens the command palette scoped to wherever you are: the session or the
 * agent's folder on screen, when there is one, so its results lead with them.
 */
export function useOpenCommandPalette(): () => void {
  const showCommandPalette = useShowModal('commandPaletteModal');
  const { currentView } = useWorkspaceSlots();
  const { params: sessionParams } = useParams('session');
  const { params: locationParams } = useParams('location');
  const locationId =
    currentView === 'session'
      ? sessionParams.locationId
      : currentView === 'location'
        ? locationParams.locationId
        : undefined;
  const sessionId = currentView === 'session' ? sessionParams.sessionId : undefined;
  return () => showCommandPalette({ locationId, sessionId });
}

/**
 * The strip across the top of the window, above the content card: search in
 * the middle, the docs on the right. It is part of the window's chrome, so it
 * drags the window everywhere its controls are not.
 *
 * With the sidebar collapsed the sidebar's own top strip is gone, so its
 * toggle and the back/forward buttons sit here instead — clear of the macOS
 * window buttons, which are drawn over this corner.
 */
export const WorkspaceTopBar = observer(function WorkspaceTopBar() {
  const { isLeftOpen, setCollapsed } = useWorkspaceLayoutContext();
  const openCommandPalette = useOpenCommandPalette();
  return (
    <div className="grid h-11 shrink-0 grid-cols-[1fr_minmax(0,420px)_1fr] items-center gap-3 pr-2 [-webkit-app-region:drag]">
      <div className={cn('flex min-w-0 items-center gap-0.5', !isLeftOpen && isMac && 'pl-[70px]')}>
        {!isLeftOpen && (
          <div className="flex items-center gap-0.5 [-webkit-app-region:no-drag]">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="size-7 p-0"
                    aria-label="Toggle left sidebar"
                    onClick={() => setCollapsed('left', isLeftOpen)}
                  >
                    <PanelLeft className="h-4 w-4" />
                  </Button>
                }
              />
              <TooltipContent>
                Toggle left sidebar
                <BoundShortcut settingsKey="toggleLeftSidebar" variant="badge" />
              </TooltipContent>
            </Tooltip>
            <NavButtons />
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={openCommandPalette}
        aria-label="Search"
        className="flex h-7 min-w-0 cursor-pointer items-center gap-2 rounded-lg bg-[var(--sel-soft)] px-2 text-xs text-foreground-passive transition-colors [-webkit-app-region:no-drag] hover:bg-[var(--sel)]"
      >
        <Search className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">Search…</span>
        <BoundShortcut settingsKey="commandPalette" />
      </button>
      <div className="flex items-center justify-end gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="size-7 p-0 [-webkit-app-region:no-drag]"
                aria-label="Docs"
                onClick={() =>
                  openExternalUrl(SWITCH_CONSOLE_DOCS_URL, 'Could not open the documentation')
                }
              >
                <BookOpen className="h-4 w-4" />
              </Button>
            }
          />
          <TooltipContent>Docs</TooltipContent>
        </Tooltip>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs [-webkit-app-region:no-drag]"
          onClick={() => openExternalUrl(SWITCH_TRUST_URL, 'Could not open Switch Trust')}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Switch Trust
        </Button>
      </div>
    </div>
  );
});
