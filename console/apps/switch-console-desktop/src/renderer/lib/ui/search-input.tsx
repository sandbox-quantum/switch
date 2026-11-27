import { SearchInput as SearchField } from '@switch-console/chat-ui/primitives/search-input';
import { useHotkey } from '@tanstack/react-hotkeys';
import * as React from 'react';

type SearchInputProps = React.ComponentProps<typeof SearchField>;

/** The shared search box, focused by Mod+F. */
const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  function SearchInput(props, forwardedRef) {
    const inputRef = React.useRef<HTMLInputElement>(null);

    React.useImperativeHandle(forwardedRef, () => inputRef.current as HTMLInputElement);

    useHotkey(
      'Mod+F',
      () => {
        inputRef.current?.focus();
      },
      { enabled: true }
    );
    return <SearchField {...props} ref={inputRef} />;
  }
);

export { SearchInput };
