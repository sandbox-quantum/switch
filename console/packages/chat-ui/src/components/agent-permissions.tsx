import type { ReactNode } from 'react';
import { Badge } from '../primitives/badge';
import { Field } from '../primitives/field';
import { InfoTooltip } from '../primitives/info-tooltip';
import { Switch } from '../primitives/switch';
import { SettingRow } from './setting-row';

/** What the two permission rows say, wherever they are shown. */
export const PERMISSION_COPY = {
  autoMode: {
    title: 'Auto mode',
    description: 'Safe actions run on their own; risky ones ask you first.',
    overridden: 'Bypass permissions is on and overrides it.',
    infoLabel: 'More info about auto mode',
    info: "The agent's provider reviews each action before it runs: Claude, Codex and Junie use their own automatic review, Antigravity and Pi approve edits and ask before commands, and DeepSeek Harness, which has no reviewer of its own, asks before every tool except those that only read or search files. OpenCode has no review: in auto mode every action runs without asking, so a new OpenCode agent starts with it off. Applies to every session, including ones started automatically.",
  },
  autoApprove: {
    title: 'Bypass permissions',
    description: 'Unsafe: every action runs without asking. Overrides auto mode.',
    infoLabel: 'More info about bypassing permissions',
    info: "Sessions start with the provider's auto-approve flag, including ones started automatically. Turn it on only for agents you trust to run unattended.",
  },
} as const;

/**
 * What the auto mode row says for agents whose providers include `unreviewed`,
 * the names of those whose auto mode nothing reviews (OpenCode): it warns that
 * every action, commands included, then runs without asking, in place of the
 * usual line.
 */
export function autoModeDescription(unreviewed: readonly string[], overridden: boolean): string {
  const copy = PERMISSION_COPY.autoMode;
  const names = [...new Set(unreviewed)];
  const line =
    names.length === 0
      ? copy.description
      : `${names.join(' and ')} ${names.length === 1 ? 'has' : 'have'} no automatic review: with this on, every action runs without asking, commands included.`;
  return overridden ? `${line} ${copy.overridden}` : line;
}

/** The "Unsafe" mark beside the bypass title. */
export function UnsafeBadge() {
  return <Badge variant="destructive">Unsafe</Badge>;
}

/** One on/off setting of a form: a whole-row label around its switch. */
export function SettingToggle({
  title,
  badge,
  infoLabel,
  info,
  description,
  checked,
  onCheckedChange,
}: {
  title: string;
  badge: ReactNode;
  infoLabel: string;
  info: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Field>
      <label className="-mx-2 flex cursor-pointer items-start justify-between gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--sel-soft)]">
        <span className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-sm">
            {title}
            {badge}
            <InfoTooltip label={infoLabel} content={info} />
          </span>
          <span className="text-xs text-foreground-muted">{description}</span>
        </span>
        <Switch
          className="mt-0.5"
          aria-label={title}
          checked={checked}
          onCheckedChange={onCheckedChange}
        />
      </label>
    </Field>
  );
}

/** One permission setting of the create form. */
export function PermissionToggle({
  setting,
  description,
  checked,
  onCheckedChange,
}: {
  setting: keyof typeof PERMISSION_COPY;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const copy = PERMISSION_COPY[setting];
  return (
    <SettingToggle
      title={copy.title}
      badge={setting === 'autoApprove' && <UnsafeBadge />}
      infoLabel={copy.infoLabel}
      info={copy.info}
      description={description}
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next)}
    />
  );
}

/** Whether the new agent may create agents on the owner's machines, set as it is created. */
export function CanManageAgentsToggle({
  machineWord,
  checked,
  onChange,
}: {
  /** What the app calls a computer that runs agents. */
  machineWord: 'machine' | 'device';
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <SettingToggle
      title="Can manage agents"
      badge={null}
      infoLabel="More info about managing agents"
      info={`The agent can see your ${machineWord}s and managed agents, and create agents that run on your ${machineWord}s and belong to you. Agents it creates do not get this permission.`}
      description={`Let this agent create agents on your ${machineWord}s.`}
      checked={checked}
      onCheckedChange={onChange}
    />
  );
}

/** The "Auto mode" row of an agent's settings, whatever holds the value its switch shows. */
export function AutoModeRow({
  unreviewed,
  overridden,
  control,
  children,
}: {
  /** The names of the row's agents' providers whose auto mode nothing reviews. */
  unreviewed: readonly string[];
  /** Bypass is on, so auto mode has no effect for now. */
  overridden: boolean;
  control: ReactNode;
  children?: ReactNode;
}) {
  const copy = PERMISSION_COPY.autoMode;
  return (
    <SettingRow
      title={copy.title}
      info={{ label: copy.infoLabel, content: copy.info }}
      description={autoModeDescription(unreviewed, overridden)}
      control={control}
    >
      {children}
    </SettingRow>
  );
}

/** The "Bypass permissions" row of an agent's settings, whatever holds the value its switch shows. */
export function AutoApproveRow({
  control,
  children,
}: {
  control: ReactNode;
  children?: ReactNode;
}) {
  const copy = PERMISSION_COPY.autoApprove;
  return (
    <SettingRow
      title={
        <>
          {copy.title}
          <UnsafeBadge />
        </>
      }
      info={{ label: copy.infoLabel, content: copy.info }}
      description={copy.description}
      control={control}
    >
      {children}
    </SettingRow>
  );
}

/**
 * Whether an existing agent may create agents on its owner's machines, as a
 * row of its settings. The server holds the value; the app saves a change as
 * it is made.
 */
export function CanManageAgentsSetting({
  agentName,
  machineWord,
  checked,
  disabled,
  onChange,
  error,
}: {
  /** Shown when several agents' rows stand together; null for one. */
  agentName: string | null;
  /** What the app calls a computer that runs agents. */
  machineWord: 'machine' | 'device';
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  error: string | null;
}) {
  return (
    <SettingRow
      title={agentName ? `${agentName}: can manage agents` : 'Can manage agents'}
      info={{
        label: 'More info about managing agents',
        content: `The agent can see your ${machineWord}s and managed agents, and create new agents that run on your ${machineWord}s and belong to you. Agents it creates do not get this permission.`,
      }}
      description={`Let this agent create agents on your ${machineWord}s.`}
      control={
        <Switch
          aria-label="Can manage agents"
          checked={checked}
          disabled={disabled}
          onCheckedChange={onChange}
        />
      }
    >
      {error && <span className="text-xs text-destructive">{error}</span>}
    </SettingRow>
  );
}

export const MID_TURN_TITLE = 'Steer messages sent while it works';
export const MID_TURN_DESCRIPTION =
  'A message sent while the agent is working reaches the running turn instead of waiting for it to end, whoever sent it and from wherever. The agent reads it at its next step: Claude Code after the tool call or answer in progress. Agents that cannot steer always queue. Off: messages from rooms wait for the turn to end.';

/** What a message sent while the agent works does, as a row of its settings: steer into the turn, or queue. */
export function MidTurnDeliverySetting({
  steer,
  disabled,
  onChange,
  error,
}: {
  steer: boolean;
  disabled: boolean;
  onChange: (mode: 'steer' | 'queue') => void;
  error: string | null;
}) {
  return (
    <SettingRow
      title={MID_TURN_TITLE}
      info={null}
      description={MID_TURN_DESCRIPTION}
      control={
        <Switch
          aria-label={MID_TURN_TITLE}
          checked={steer}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(checked ? 'steer' : 'queue')}
        />
      }
    >
      {error && <p role="alert">{error}</p>}
    </SettingRow>
  );
}
