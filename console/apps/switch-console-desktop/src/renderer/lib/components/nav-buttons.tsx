import { ArrowLeft, ArrowRight } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { appState } from '@renderer/lib/stores/app-state';
import type { HistoryEntry } from '@renderer/lib/stores/navigation-history-store';
import { Button } from '@switch-console/chat-ui/primitives/button';
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
import { Tooltip, TooltipContent, TooltipTrigger } from '@switch-console/chat-ui/primitives/tooltip';

export function applyHistoryEntry(entry: HistoryEntry): void {
  if (entry.kind === 'view') {
    appState.navigation._applyNavigation(entry.viewId, entry.params);
  }
}

export const NavButtons = observer(function NavButtons() {
  const { canGoBack, canGoForward } = appState.history;
  return (
    <div className="flex items-center gap-0.5 [-webkit-app-region:no-drag]">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="size-7 p-0"
              aria-label="Go back"
              disabled={!canGoBack}
              onClick={() => appState.history.back(applyHistoryEntry)}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          }
        />
        <TooltipContent>
          Go Back
          <BoundShortcut settingsKey="navigateBack" variant="badge" />
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="size-7 p-0"
              aria-label="Go forward"
              disabled={!canGoForward}
              onClick={() => appState.history.forward(applyHistoryEntry)}
            >
              <ArrowRight className="h-4 w-4" />
            </Button>
          }
        />
        <TooltipContent>
          Go Forward
          <BoundShortcut settingsKey="navigateForward" variant="badge" />
        </TooltipContent>
      </Tooltip>
    </div>
  );
});
