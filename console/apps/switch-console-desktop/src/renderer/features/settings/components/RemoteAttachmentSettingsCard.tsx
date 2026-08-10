import React, { useCallback } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { SettingRow } from './SettingRow';

/**
 * Sessions on one remote host share a single SSH connection. Past a handful of
 * open terminals the slower tunnels (IAP, SSM) stop answering channel opens and
 * the connection is torn down and rebuilt in a loop, so this is capped. Raising
 * it is safe on a fast host and risky on a slow one, which is why it is a
 * choice rather than a constant.
 */
const CHOICES = [2, 4, 6, 8, 12] as const;

const RemoteAttachmentSettingsCard: React.FC = () => {
  const {
    value: remote,
    update,
    isLoading: loading,
    isSaving: saving,
  } = useAppSettingsKey('remote');

  const cap = remote?.maxAttachedSessionsPerHost ?? 4;

  const applyCap = useCallback(
    (next: string | null) => {
      if (next === null) return;
      update({ maxAttachedSessionsPerHost: Number(next) });
    },
    [update]
  );

  return (
    <SettingRow
      title="Open remote terminals per host"
      description="How many sessions on the same remote host keep a live terminal. Others stay detached — their agents keep running and their status stays live, and a terminal opens when you view them."
      control={
        <Select value={String(cap)} onValueChange={applyCap} disabled={loading || saving}>
          <SelectTrigger className="w-[183px] shrink-0 gap-2">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHOICES.map((choice) => (
              <SelectItem key={choice} value={String(choice)}>
                {choice} sessions
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  );
};

export default RemoteAttachmentSettingsCard;
