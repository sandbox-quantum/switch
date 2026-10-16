import { useHotkey } from '@tanstack/react-hotkeys';
import { useRef } from 'react';
import {
  getEffectiveHotkey,
  getHotkeyRegistration,
} from '@renderer/lib/hooks/useKeyboardShortcuts';
import { Button } from '@renderer/lib/ui/button';
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
import { useAgentEdits } from './agent-edits';

/**
 * The agent page's pending changes, and what to do about them (CHOO-2228).
 *
 * Shown only when something is actually unsaved, so the page is not permanently
 * wearing a bar it has no use for. It sits above the scrolling content, so it
 * stays in view wherever on the page the edit was made.
 */
export function AgentSaveBar() {
  const { dirty, saving, saveAll, revertAll } = useAgentEdits();
  const saveRef = useRef<HTMLButtonElement>(null);

  // Bound here rather than globally: ⌘S means "save these edits" only while
  // there are edits to save, and typing in the instructions box is exactly when
  // someone reaches for it — so this must fire with a textarea focused.
  useHotkey(
    getHotkeyRegistration('saveChanges'),
    (event) => {
      event.preventDefault();
      saveRef.current?.click();
    },
    { enabled: dirty && !saving && getEffectiveHotkey('saveChanges') !== null }
  );

  if (!dirty) return null;

  return (
    <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border-warning bg-background-warning px-8 py-2">
      <span className="text-sm font-medium text-foreground-warning">Unsaved changes</span>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={saving} onClick={revertAll}>
          Discard
        </Button>
        <Button
          ref={saveRef}
          type="button"
          size="sm"
          disabled={saving}
          onClick={() => void saveAll()}
        >
          <span className="flex items-center gap-2">
            {saving ? 'Saving…' : 'Save'}
            <BoundShortcut settingsKey="saveChanges" />
          </span>
        </Button>
      </div>
    </div>
  );
}
