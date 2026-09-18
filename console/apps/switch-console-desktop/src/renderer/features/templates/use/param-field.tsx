import type { ParamSpec } from '@main/core/room-templates/controller';
import { AgentTypePicker } from '@renderer/features/locations/components/add-agent-modal/agent-type-picker';
import { LocalDirectorySelector } from '@renderer/features/locations/components/add-agent-modal/local-directory-selector';
import {
  AgentField,
  BridgeField,
  type EntityLists,
  UserField,
} from '@renderer/features/room-templates/entity-fields';
import { Input } from '@renderer/lib/ui/input';
import { Switch } from '@renderer/lib/ui/switch';
import { Textarea } from '@renderer/lib/ui/textarea';
import { cn } from '@renderer/utils/utils';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { RoomChoiceField } from './room-pick-field';
import { RunLocationSelect } from './run-location-select';
import { isChain, isRequired, paramLabel, typeLabel } from './use-template-model';

/** One input of a template on the Use page, with the control its type calls for. */
export function ParamField({
  param,
  value,
  onChange,
  error,
  lists,
  sshHost,
  hosts,
  newRoom,
  disabled,
  onNavigateAway,
}: {
  param: ParamSpec;
  value: string | number | boolean;
  onChange: (v: string | number | boolean) => void;
  error: string | null;
  lists: EntityLists;
  /** The machine a `provider` must be installed on and a `directory` lives on: an SSH host, or null for this computer. */
  sshHost: string | null;
  /** The SSH hosts a `location` param may name. */
  hosts: readonly { sshHost: string; name: string }[];
  /** For a `room` param: the room the template creates, offered as `$new`. */
  newRoom: { name: string; bridgeType: string | null } | null;
  disabled?: boolean;
  onNavigateAway: () => void;
}) {
  const required = isRequired(param);
  const strVal = typeof value === 'string' ? value : String(value ?? '');
  const showDefault = param.default !== null && !isChain(param) && param.type !== 'boolean';

  let control: React.ReactNode;
  if (param.type === 'boolean') {
    control = (
      <label className="flex w-max cursor-pointer items-center gap-2.5 text-sm text-foreground-muted">
        <Switch
          checked={Boolean(value)}
          onCheckedChange={(checked) => onChange(checked)}
          disabled={disabled}
        />
        {value ? 'Yes' : 'No'}
      </label>
    );
  } else if (param.type === 'provider') {
    control = (
      <AgentTypePicker
        value={(strVal || null) as AgentProviderId | null}
        onChange={(id) => onChange(id)}
        sshHost={sshHost ?? undefined}
        onNavigateAway={onNavigateAway}
      />
    );
  } else if (param.type === 'location') {
    control = (
      <RunLocationSelect
        value={strVal || 'local'}
        onChange={onChange}
        hosts={hosts}
        disabled={disabled}
      />
    );
  } else if (param.type === 'directory') {
    control = sshHost ? (
      <Input
        value={strVal}
        disabled={disabled}
        placeholder="/home/agent/repo"
        className="font-mono text-xs"
        onChange={(e) => onChange(e.target.value)}
      />
    ) : (
      <LocalDirectorySelector
        title="Choose the agent's working directory"
        message="The agent runs from here. The folder is created when the agent is."
        path={strVal}
        onPathChange={onChange}
      />
    );
  } else if (param.type === 'room') {
    control = (
      <RoomChoiceField
        rooms={lists.rooms}
        loading={lists.roomsLoading}
        newRoom={newRoom}
        value={strVal}
        onChange={onChange}
      />
    );
  } else if (param.type === 'agent') {
    control = <AgentField value={strVal} onChange={onChange} lists={lists} />;
  } else if (param.type === 'bridge') {
    control = <BridgeField value={strVal} onChange={onChange} lists={lists} />;
  } else if (param.type === 'user') {
    control = <UserField value={strVal} onChange={onChange} lists={lists} />;
  } else if (param.type === 'enum' && param.enum) {
    control = (
      <div className="flex flex-wrap gap-1.5">
        {param.enum.map((opt) => {
          const on = strVal === opt;
          return (
            <button
              key={opt}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => onChange(on ? '' : opt)}
              className={cn(
                'h-[30px] cursor-pointer rounded-lg border px-2.5 font-mono text-xs transition-colors',
                on
                  ? 'border-foreground bg-[var(--sel)] text-foreground'
                  : 'border-border text-foreground-muted hover:bg-[var(--sel-soft)]'
              )}
            >
              {opt}
            </button>
          );
        })}
      </div>
    );
  } else if (param.type === 'number') {
    control = (
      <Input
        type="number"
        className="w-32 font-mono"
        value={value === '' ? '' : Number(value)}
        min={param.min ?? undefined}
        max={param.max ?? undefined}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        placeholder={showDefault ? String(param.default) : param.name}
        aria-invalid={error ? true : undefined}
      />
    );
  } else if (param.multiline) {
    control = (
      <Textarea
        value={strVal}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-40 resize-y font-mono text-xs"
        aria-invalid={error ? true : undefined}
      />
    );
  } else {
    control = (
      <Input
        value={strVal}
        className={param.label ? undefined : 'font-mono'}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={showDefault ? String(param.default) : param.name}
        aria-invalid={error ? true : undefined}
      />
    );
  }

  const label = paramLabel(param);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            'text-[12.5px] font-medium text-foreground',
            label === param.name && 'font-mono'
          )}
        >
          {label}
        </span>
        <span className="text-[11px] text-foreground-passive">{typeLabel(param.type)}</span>
        <span className="flex-1" />
        <span
          className={cn(
            'text-[11px]',
            required ? 'text-amber-600 dark:text-amber-400' : 'text-foreground-passive'
          )}
        >
          {required ? 'Required' : 'Optional'}
        </span>
      </div>
      {param.description && (
        <p className="text-xs leading-relaxed text-foreground-muted">{param.description}</p>
      )}
      {control}
      {showDefault && (
        <p className="text-[11.5px] text-foreground-passive">Defaults to {String(param.default)}</p>
      )}
      {isChain(param) && (
        <p className="text-[11.5px] text-foreground-passive">
          The template tries{' '}
          {param.default
            .map((c) => (c === '$first' ? 'the first one' : c === '$new' ? 'its own room' : c))
            .join(', then ')}
          .
        </p>
      )}
      {param.type === 'bridge' && !required && isEmpty(value) && (
        <p className="text-[11.5px] text-foreground-passive">
          Left empty, the room is created on the server's default messaging app.
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function isEmpty(value: string | number | boolean): boolean {
  return value === '';
}
