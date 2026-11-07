import { Input } from '@renderer/lib/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';

export function ServiceFieldInputs({
  idPrefix,
  label,
  fields,
  values,
  disabled,
  onChange,
}: {
  idPrefix: string;
  label: string;
  fields: ReadonlyArray<{
    name: string;
    label: string;
    help: string | null;
    secret?: boolean;
    choices?: string[] | null;
  }>;
  values: Record<string, string>;
  disabled: boolean;
  onChange: (name: string, value: string) => void;
}) {
  return (
    <div role="group" aria-label={label} className="space-y-3">
      {fields.map((field) => {
        const id = `${idPrefix}-${field.name}`;
        const value = values[field.name] ?? '';
        const set = (next: string) => onChange(field.name, next);
        return (
          <div key={field.name} className="space-y-1">
            <label htmlFor={id} className="block text-sm font-medium">
              {field.label}
            </label>
            {field.choices ? (
              <Select value={value || null} onValueChange={(next) => set(next ?? '')}>
                <SelectTrigger id={id} aria-label={field.label} className="w-full">
                  <SelectValue placeholder={`Choose a ${field.label.toLowerCase()}`}>
                    {value || undefined}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {field.choices.map((choice) => (
                    <SelectItem key={choice} value={choice}>
                      {choice}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id={id}
                type={field.secret ? 'password' : 'text'}
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                value={value}
                onChange={(event) => set(event.target.value)}
              />
            )}
            {field.help && <p className="text-xs text-foreground-muted">{field.help}</p>}
          </div>
        );
      })}
    </div>
  );
}

export function fieldMatches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return value !== '';
  }
}
