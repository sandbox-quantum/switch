import { ExternalLink } from 'lucide-react';
import React, { useCallback, useRef, useState } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { openExternalUrl } from '@renderer/lib/open-external';
import { Button } from '@renderer/lib/ui/button';
import { Dialog, DialogContent, DialogContentArea, DialogFooter } from '@renderer/lib/ui/dialog';
import { Shortcut } from '@renderer/lib/ui/shortcut';
import { Switch } from '@renderer/lib/ui/switch';
import {
  TELEMETRY_DETAILS_LABEL,
  TELEMETRY_DETAILS_URL,
  TELEMETRY_SCOPE_NOTE,
  TELEMETRY_SUMMARY,
} from './telemetry-copy';

/**
 * The first-run telemetry notice.
 *
 * Rendered only when the user has never acknowledged it, and not dismissible:
 * acknowledgement is recorded by `askedAt`, so closing it without answering
 * would leave the app showing it again on every launch. The toggle starts on,
 * matching the default — sharing is opt-out — so the notice's job is to tell
 * the user it is happening and put the off switch in front of them before they
 * go any further.
 *
 * It says the data is anonymous and links to the full account rather than
 * listing fields: the itemised version runs to every event and every field, and
 * a dialog that tries to hold it gets skimmed instead of read.
 */
export function TelemetryConsentDialog({ onAnswered }: { onAnswered: () => void }) {
  const { value, updateAsync } = useAppSettingsKey('telemetry');
  const [enabled, setEnabled] = useState(value?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);

  const confirm = useCallback(() => {
    setSaving(true);
    void updateAsync({ enabled, askedAt: Date.now() })
      .then(onAnswered)
      .finally(() => setSaving(false));
  }, [enabled, onAnswered, updateAsync]);

  // Enter confirms, because the footer advertises it. The switch answers to
  // Space, so this does not steal the keyboard from changing the choice.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== 'Enter' || saving) return;
      event.preventDefault();
      confirm();
    },
    [confirm, saving]
  );

  return (
    // Controlled `open` with no `onOpenChange`: Escape and outside clicks are
    // requests the parent ignores, so the notice cannot be dismissed unanswered.
    <Dialog open>
      {/* Focus the popup, not its first tabbable child. The default would land
          on the consent switch, which renders its focus ring as a highlighted
          band around the toggle row — pulling the eye to the control before the
          text that explains it. */}
      <DialogContent
        ref={popupRef}
        initialFocus={popupRef}
        aria-labelledby="telemetry-consent-heading"
        onKeyDown={onKeyDown}
      >
        <div className="flex flex-col gap-2 p-6 pb-4">
          <h2 id="telemetry-consent-heading" className="text-base font-normal text-foreground">
            Help improve Switch Console
          </h2>
          <p className="text-sm text-foreground-muted">{TELEMETRY_SUMMARY}</p>
          <p className="text-sm text-foreground-muted">{TELEMETRY_SCOPE_NOTE}</p>
        </div>
        <DialogContentArea className="gap-4">
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-background-1 p-3">
            <label htmlFor="telemetry-consent-switch" className="text-sm text-foreground">
              Share usage data
            </label>
            <Switch
              id="telemetry-consent-switch"
              checked={enabled}
              disabled={saving}
              onCheckedChange={setEnabled}
              className="data-checked:bg-foreground-success [&[data-checked]:not([data-disabled]):hover]:bg-foreground-success/85"
            />
          </div>
          <button
            type="button"
            className="inline-flex w-fit cursor-pointer items-center gap-1.5 text-xs text-foreground-tertiary-passive underline-offset-2 transition-colors hover:text-foreground hover:underline"
            onClick={() => {
              void openExternalUrl(TELEMETRY_DETAILS_URL, 'Could not open the telemetry document');
            }}
          >
            {TELEMETRY_DETAILS_LABEL}
            <ExternalLink aria-hidden className="size-3" />
          </button>
        </DialogContentArea>
        <DialogFooter>
          <Button disabled={saving} onClick={confirm}>
            Continue <Shortcut hotkey="Enter" variant="badge" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default TelemetryConsentDialog;
