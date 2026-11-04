import { Input } from '@renderer/lib/ui/input';

/** The new room's name; Enter submits, except an Enter the IME is handling. */
export function RoomNameInput({
  id,
  value,
  onChange,
  onSubmit,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <Input
      id={id}
      autoFocus
      placeholder="Name this room"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        // keyCode 229: a key the IME is handling, which some IMEs send with isComposing false.
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        // ⌘↩ / Ctrl+↩ is the dialog's own confirm; answering it here too would submit twice.
        if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) onSubmit();
      }}
    />
  );
}
