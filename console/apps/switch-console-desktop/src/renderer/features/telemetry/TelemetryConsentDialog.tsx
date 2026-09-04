import { CheckIcon, XIcon } from 'lucide-react';
import React, { useCallback, useRef, useState } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { Button } from '@renderer/lib/ui/button';
import { Dialog, DialogContent, DialogContentArea, DialogFooter } from '@renderer/lib/ui/dialog';
import { SectionLabel } from '@renderer/lib/ui/label';
import { Shortcut } from '@renderer/lib/ui/shortcut';
import { Switch } from '@renderer/lib/ui/switch';
import {
  TELEMETRY_NEVER_SHARED,
  TELEMETRY_REVERSIBLE,
  TELEMETRY_SHARED,
  TELEMETRY_SUMMARY,
} from './telemetry-copy';

function DisclosureList({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: 'shared' | 'never';
}) {
  const Icon = tone === 'shared' ? CheckIcon : XIcon;
  return (
    <div className="flex flex-col gap-1.5">
      <SectionLabel className="text-foreground-tertiary-passive">{title}</SectionLabel>
      <ul className="flex flex-col gap-1.5">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2 text-sm text-foreground-muted">
            <Icon
              aria-hidden
              className={
                tone === 'shared'
                  ? 'mt-0.5 size-3.5 shrink-0 text-foreground-success'
                  : 'mt-0.5 size-3.5 shrink-0 text-foreground-tertiary-passive'
              }
            />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The first-run consent prompt.
 *
 * Rendered only when the user has never answered it, and not dismissible: the
 * answer is recorded by `askedAt`, so closing it without choosing would leave
 * the app asking again on every launch. The toggle starts off, matching the
 * default: what is sent carries a random per-install id, so sharing has to be
 * something the user turns on rather than something they failed to turn off.
 */
export function TelemetryConsentDialog({ onAnswered }: { onAnswered: () => void }) {
  const { value, updateAsync } = useAppSettingsKey('telemetry');
  const [enabled, setEnabled] = useState(value?.enabled ?? false);
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
    // requests the parent ignores, so the prompt cannot be dismissed unanswered.
    <Dialog open>
      {/* Focus the popup, not its first tabbable child. The default would land
          on the consent switch, which renders its focus ring as a highlighted
          band around the toggle row — reading as a pre-selected answer to a
          question the user has not answered yet. */}
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
        </div>
        <DialogContentArea className="gap-4">
          <DisclosureList title="What is shared" items={TELEMETRY_SHARED} tone="shared" />
          <DisclosureList
            title="What is never shared"
            items={TELEMETRY_NEVER_SHARED}
            tone="never"
          />
          <div className="mt-1 flex items-center justify-between gap-4 rounded-lg border border-border bg-background-1 p-3">
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
          <p className="text-xs text-foreground-tertiary-passive">{TELEMETRY_REVERSIBLE}</p>
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
