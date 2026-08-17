import type { Button as ButtonPrimitive } from '@base-ui/react/button';
import { useHotkey } from '@tanstack/react-hotkeys';
import type { VariantProps } from 'class-variance-authority';
import { useRef } from 'react';
import {
  getEffectiveHotkey,
  getHotkeyRegistration,
} from '@renderer/lib/hooks/useKeyboardShortcuts';
import { Button, type buttonVariants } from './button';
import { BoundShortcut } from './shortcut';

type ConfirmButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants>;

export function ConfirmButton({ disabled, children, ...props }: ConfirmButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const confirmHotkey = getEffectiveHotkey('confirm');

  useHotkey(getHotkeyRegistration('confirm'), () => ref.current?.click(), {
    enabled: !disabled && confirmHotkey !== null,
  });

  return (
    <Button ref={ref} disabled={disabled} {...props}>
      <span className="flex items-center gap-2">
        {children}
        <BoundShortcut settingsKey="confirm" />
      </span>
    </Button>
  );
}
