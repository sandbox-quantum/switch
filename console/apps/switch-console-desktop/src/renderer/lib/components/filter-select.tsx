import type { ReactNode } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';

const ANY = '__any__';

/**
 * One narrowing filter on a list page's filter row: "any" first, then each
 * value it can take, so picking nothing and picking "any" read the same.
 */
export function FilterSelect({
  label,
  anyLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  anyLabel: string;
  value: string | null;
  options: { value: string; label: string; icon?: ReactNode }[];
  onChange: (next: string | null) => void;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <Select
      value={value ?? ANY}
      onValueChange={(next) => onChange(next === ANY ? null : (next as string))}
    >
      <SelectTrigger size="sm" className="w-auto min-w-[150px]" aria-label={label}>
        <SelectValue>
          {current ? (
            <span className="flex items-center gap-1.5">
              {current.icon}
              {current.label}
            </span>
          ) : (
            anyLabel
          )}
        </SelectValue>
      </SelectTrigger>
      {/* As wide as its longest name, so two connections that differ only at the end stay told apart. */}
      <SelectContent
        align="start"
        alignItemWithTrigger={false}
        className="w-auto min-w-(--anchor-width)"
      >
        <SelectItem value={ANY}>{anyLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <span className="flex items-center gap-1.5">
              {option.icon}
              {option.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
