import { useState, useEffect } from 'react';
import { CronPicker } from '@renderer/lib/CronPicker';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { useWorkspaceAgents } from '@renderer/lib/stores/use-workspace-agents';
import { Button } from '@renderer/lib/ui/button';
import {
  Dialog,
  DialogContent,
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Input } from '@renderer/lib/ui/input';
import { Label } from '@renderer/lib/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Textarea } from '@renderer/lib/ui/textarea';
import type { RemoteRoomSchedule } from '@shared/core/switch-servers/switch-servers';

const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Kolkata',
  'Australia/Sydney',
];

interface ScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  roomId: string;
  roomAgentIds: string[];
  schedule?: RemoteRoomSchedule | null;
  onSaved: () => void;
}

export function ScheduleDialog({
  open,
  onOpenChange,
  workspaceId,
  roomId,
  roomAgentIds,
  schedule,
  onSaved,
}: ScheduleDialogProps) {
  const remoteAgents = useWorkspaceAgents(workspaceId);
  const agentMap = new Map((remoteAgents.data ?? []).map((a) => [a.id, a.displayName || a.name]));

  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const timezones = Array.from(new Set([localTz, ...COMMON_TIMEZONES]));

  const [name, setName] = useState('');
  const [scheduleType, setScheduleType] = useState<'recurring' | 'one_off'>('recurring');
  const [cronExpr, setCronExpr] = useState('0 9 * * *');
  const [timezone, setTimezone] = useState(localTz);
  const [runAt, setRunAt] = useState('');
  const [message, setMessage] = useState('');
  const [targetAgentIds, setTargetAgentIds] = useState<string[]>([]);
  const [missedRunPolicy, setMissedRunPolicy] = useState<'run_once' | 'skip'>('run_once');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (schedule) {
      setName(schedule.name);
      setScheduleType(schedule.scheduleType);
      setCronExpr(schedule.cronExpr ?? '0 9 * * *');
      setTimezone(schedule.timezone || localTz);
      if (schedule.runAt) {
        // Format ISO date to YYYY-MM-DDTHH:mm for datetime-local input
        const d = new Date(schedule.runAt);
        const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16);
        setRunAt(iso);
      } else {
        setRunAt('');
      }
      setMessage(schedule.message);
      setTargetAgentIds(schedule.targetAgentIds ?? []);
      setMissedRunPolicy(
        schedule.missedRunPolicy === 'skip' ? 'skip' : 'run_once'
      );
    } else {
      setName('');
      setScheduleType('recurring');
      setCronExpr('0 9 * * *');
      setTimezone(localTz);
      // default runAt 1 hour from now
      const inOneHour = new Date(Date.now() + 3600000);
      const iso = new Date(inOneHour.getTime() - inOneHour.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16);
      setRunAt(iso);
      setMessage('');
      setTargetAgentIds([]);
      setMissedRunPolicy('run_once');
    }
    setError(null);
  }, [schedule, open, localTz]);

  const toggleTargetAgent = (agentId: string) => {
    setTargetAgentIds((prev) =>
      prev.includes(agentId) ? prev.filter((id) => id !== agentId) : [...prev, agentId]
    );
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Please provide a name for this schedule.');
      return;
    }
    if (!message.trim()) {
      setError('Please provide a message to send.');
      return;
    }
    if (scheduleType === 'one_off' && !runAt) {
      setError('Please select a date and time for one-off delivery.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (schedule) {
        await rpc.workspaces.updateRoomSchedule({
          workspaceId,
          roomId,
          scheduleId: schedule.id,
          name: name.trim(),
          cronExpr: scheduleType === 'recurring' ? cronExpr : null,
          timezone,
          runAt: scheduleType === 'one_off' ? new Date(runAt).toISOString() : null,
          message: message.trim(),
          targetAgentIds,
          missedRunPolicy,
        });
      } else {
        await rpc.workspaces.createRoomSchedule({
          workspaceId,
          roomId,
          name: name.trim(),
          scheduleType,
          cronExpr: scheduleType === 'recurring' ? cronExpr : null,
          timezone,
          runAt: scheduleType === 'one_off' ? new Date(runAt).toISOString() : null,
          message: message.trim(),
          targetAgentIds,
          missedRunPolicy,
        });
      }
      onSaved();
      onOpenChange(false);
    } catch (cause) {
      setError(failureText(cause, 'Could not save the schedule.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>
            {schedule ? 'Edit Scheduled Message' : 'New Scheduled Message'}
          </DialogTitle>
        </DialogHeader>

        <DialogContentArea className="space-y-4 pt-2">
          {error && (
            <div className="rounded-md bg-destructive/10 p-2.5 text-xs text-destructive">
              {error}
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-foreground">Schedule Name</Label>
            <Input
              placeholder="e.g. Daily Standup Check-in"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-foreground">Schedule Type</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={scheduleType === 'recurring' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setScheduleType('recurring')}
              >
                Recurring (Cron)
              </Button>
              <Button
                type="button"
                variant={scheduleType === 'one_off' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setScheduleType('one_off')}
              >
                One-off (Specific Time)
              </Button>
            </div>
          </div>

          {scheduleType === 'recurring' ? (
            <div className="space-y-3 rounded-lg border border-border p-3 bg-muted/10">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-foreground">Frequency</Label>
                <CronPicker value={cronExpr} onChange={setCronExpr} />
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-foreground">Timezone</Label>
                  <Select value={timezone} onValueChange={(v) => v && setTimezone(v)}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {timezones.map((tz) => (
                        <SelectItem key={tz} value={tz}>
                          {tz}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-foreground">Missed Run Policy</Label>
                  <Select
                    value={missedRunPolicy}
                    onValueChange={(v) => setMissedRunPolicy(v as 'run_once' | 'skip')}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="min-w-[155px]">
                      <SelectItem value="run_once">Run once on wake</SelectItem>
                      <SelectItem value="skip">Skip if overdue</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5 rounded-lg border border-border p-3 bg-muted/10">
              <Label className="text-xs font-medium text-foreground">Deliver At</Label>
              <Input
                type="datetime-local"
                value={runAt}
                onChange={(e) => setRunAt(e.target.value)}
              />
              <span className="text-[11px] text-foreground-muted">
                Local time ({localTz})
              </span>
            </div>
          )}

          {roomAgentIds.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-foreground">
                Target Agents (optional)
              </Label>
              <p className="text-[11px] text-foreground-muted">
                Select which room agents should be tagged or prompted. If none are selected, message is broadcast to all.
              </p>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {roomAgentIds.map((agentId) => {
                  const isSelected = targetAgentIds.includes(agentId);
                  const agentName = agentMap.get(agentId) || agentId.slice(0, 8);
                  return (
                    <button
                      key={agentId}
                      type="button"
                      onClick={() => toggleTargetAgent(agentId)}
                      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs border transition-colors ${
                        isSelected
                          ? 'border-primary bg-primary/10 text-primary font-medium'
                          : 'border-border bg-background text-foreground-muted hover:border-border-hover'
                      }`}
                    >
                      <span>@{agentName}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-foreground">Message</Label>
            <Textarea
              rows={4}
              placeholder="What message or prompt should be dispatched at the scheduled time?"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <span className="text-[11px] text-foreground-muted">
              Delivered on your behalf via Switch system actor into the room channel.
            </span>
          </div>
        </DialogContentArea>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={() => void handleSave()} disabled={saving}>
            {saving ? 'Saving…' : schedule ? 'Save Changes' : 'Create Schedule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
