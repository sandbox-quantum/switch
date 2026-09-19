import type { ParamSpec } from '@main/core/room-templates/controller';
import { AgentTypePicker } from '@renderer/features/locations/components/add-agent-modal/agent-type-picker';
import {
  AgentField,
  BridgeField,
  type EntityLists,
  RoomField,
  UserField,
} from '@renderer/features/room-templates/entity-fields';
import { Input } from '@renderer/lib/ui/input';
import { Switch } from '@renderer/lib/ui/switch';
import { Textarea } from '@renderer/lib/ui/textarea';
import { cn } from '@renderer/utils/utils';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { isEntityParamType } from '@shared/core/switch-servers/room-template-params';
import { isRequired, typeLabel } from './use-template-model';

/** One input of a template on the Use page, with the control its type calls for. */
export function ParamField({
  param,
  value,
  onChange,
  error,
  lists,
  sshHost,
  onNavigateAway,
}: {
  param: ParamSpec;
  value: string | number | boolean;
  onChange: (v: string | number | boolean) => void;
  error: string | null;
  lists: EntityLists;
  /** The machine a `provider` must be installed on: an SSH host, or null for this computer. */
  sshHost: string | null;
  onNavigateAway: () => void;
}) {
  const required = isRequired(param);
  const strVal = typeof value === 'string' ? value : String(value ?? '');
  const showDefault = param.default !== null && param.type !== 'boolean';

  let control: React.ReactNode;
  if (param.type === 'boolean') {
    control = (
      <label className="flex w-max cursor-pointer items-center gap-2.5 text-sm text-foreground-muted">
        <Switch checked={Boolean(value)} onCheckedChange={(checked) => onChange(checked)} />
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
  } else if (isEntityParamType(param.type)) {
    control =
      param.type === 'agent' ? (
        <AgentField value={strVal} onChange={onChange} lists={lists} />
      ) : param.type === 'room' ? (
        <RoomField value={strVal} onChange={onChange} lists={lists} />
      ) : param.type === 'bridge' ? (
        <BridgeField value={strVal} onChange={onChange} lists={lists} />
      ) : (
        <UserField value={strVal} onChange={onChange} lists={lists} />
      );
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
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        placeholder={param.default !== null ? String(param.default) : param.name}
        aria-invalid={error ? true : undefined}
      />
    );
  } else if (param.multiline) {
    control = (
      <Textarea
        value={strVal}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-40 resize-y font-mono text-xs"
        aria-invalid={error ? true : undefined}
      />
    );
  } else {
    control = (
      <Input
        value={strVal}
        className="font-mono"
        onChange={(e) => onChange(e.target.value)}
        placeholder={param.default !== null ? String(param.default) : param.name}
        aria-invalid={error ? true : undefined}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[12.5px] font-medium text-foreground">{param.name}</span>
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
      {param.type === 'bridge' && param.default === null && (
        <p className="text-[11.5px] text-foreground-passive">
          Leave it empty for the server's default messaging app.
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
