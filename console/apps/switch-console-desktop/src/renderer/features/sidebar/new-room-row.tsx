import { Plus } from 'lucide-react';

/** The "+ New Room" row heading a room list, styled as the Sessions header's New Session row. */
export function NewRoomRow({ onCreate }: { onCreate: () => void }) {
  return (
    <button
      type="button"
      onClick={onCreate}
      className="flex w-full cursor-pointer items-center gap-[9px] rounded-lg px-[9px] py-[6px] text-sm text-foreground-muted transition-colors hover:bg-[var(--sel-soft)] hover:text-foreground"
    >
      <Plus className="size-4 shrink-0" />
      New Room
    </button>
  );
}
