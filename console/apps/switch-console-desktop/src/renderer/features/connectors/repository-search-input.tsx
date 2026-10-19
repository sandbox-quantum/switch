import { Search, X } from 'lucide-react';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@renderer/lib/ui/input-group';

/** The search field over a list of repositories, with a clear once something is typed. */
export function RepositorySearchInput({
  value,
  onChange,
  label,
  placeholder,
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  autoFocus?: boolean;
}) {
  return (
    <InputGroup>
      <InputGroupAddon>
        <Search className="size-3.5 text-foreground-muted" />
      </InputGroupAddon>
      <InputGroupInput
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value !== '' && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label="Clear the search"
            onClick={() => onChange('')}
          >
            <X className="size-3.5" />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}
