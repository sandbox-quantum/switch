import { Search } from 'lucide-react';
import * as React from 'react';
import { cn } from '../model/cn';
import { Input } from './input';

type SearchInputProps = React.ComponentProps<'input'> & {
  containerClassName?: string;
};

/** A text input with a search glyph inside its leading edge. */
const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { className, containerClassName, ...props },
  ref
) {
  return (
    <div className={cn('relative flex min-w-0 items-center', containerClassName)}>
      <Search className="pointer-events-none absolute left-2.5 size-3.5 shrink-0 text-foreground-muted" />
      <Input className={cn('pl-8', className)} {...props} ref={ref} />
    </div>
  );
});

export { SearchInput };
