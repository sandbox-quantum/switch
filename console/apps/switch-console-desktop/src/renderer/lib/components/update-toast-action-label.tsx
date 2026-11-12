import { ArrowUpRight } from 'lucide-react';

/** The action label of an update toast: the text, and an arrow that nudges on hover. */
export function createUpdateToastActionLabel(text: string) {
  return (
    <span className="flex items-center gap-1.5">
      {text}
      <ArrowUpRight className="size-3.5 transition-transform duration-200 group-hover/action:translate-x-px group-hover/action:-translate-y-px" />
    </span>
  );
}
