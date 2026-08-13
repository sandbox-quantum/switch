import { CheckIcon, XIcon } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { Button } from '@renderer/lib/ui/button';
import { Dialog, DialogContent, DialogContentArea, DialogFooter } from '@renderer/lib/ui/dialog';
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
    <div className="flex flex-col gap-2">
      <h3 className="font-mono text-xs tracking-wider text-foreground-tertiary-passive uppercase">
        {title}
      </h3>
      <ul className="flex flex-col gap-1.5">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2 text-sm text-foreground-muted">
            <Icon
              aria-hidden
              className={
                tone === 'shared'
                  ? 'mt-0.5 size-3.5 shrink-0 text-foreground-tertiary'
                  : 'mt-0.5 size-3.5 shrink-0 text-foreground-tertiary-muted'
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
 * the app asking again on every launch. Declining is a first-class option, not
 * a hidden one — the toggle starts on, matching the default, and the user can
 * turn it off before continuing.
 */
export function TelemetryConsentDialog({ onAnswered }: { onAnswered: () => void }) {
  const { value, updateAsync } = useAppSettingsKey('telemetry');
  const [enabled, setEnabled] = useState(value?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  const confirm = useCallback(() => {
    setSaving(true);
    void updateAsync({ enabled, askedAt: Date.now() })
      .then(onAnswered)
      .finally(() => setSaving(false));
  }, [enabled, onAnswered, updateAsync]);

  return (
    // Controlled `open` with no `onOpenChange`: Escape and outside clicks are
    // requests the parent ignores, so the prompt cannot be dismissed unanswered.
    <Dialog open>
      <DialogContent aria-labelledby="telemetry-consent-heading">
        <div className="flex flex-col gap-2 p-6 pb-4">
          <h2 id="telemetry-consent-heading" className="text-base font-normal text-foreground">
            Help improve Switch Console
          </h2>
          <p className="text-sm text-foreground-muted">{TELEMETRY_SUMMARY}</p>
        </div>
        <DialogContentArea className="gap-5">
          <DisclosureList title="What is shared" items={TELEMETRY_SHARED} tone="shared" />
          <DisclosureList
            title="What is never shared"
            items={TELEMETRY_NEVER_SHARED}
            tone="never"
          />
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-background-1 p-3">
            <label htmlFor="telemetry-consent-switch" className="text-sm text-foreground">
              Share anonymous usage data
            </label>
            <Switch
              id="telemetry-consent-switch"
              checked={enabled}
              disabled={saving}
              onCheckedChange={setEnabled}
            />
          </div>
          <p className="text-sm text-foreground-tertiary">{TELEMETRY_REVERSIBLE}</p>
        </DialogContentArea>
        <DialogFooter>
          <Button disabled={saving} onClick={confirm}>
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default TelemetryConsentDialog;
